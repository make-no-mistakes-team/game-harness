package io.gameharness.survival;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.passive.AnimalEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/**
 * Mine-AI-inspired high-level action runner with an async macro task queue.
 * Guarantees continuous purposeful play with ZERO pauses while waiting for LLM replies.
 */
final class TaskRunner {
    enum TaskKind {
        GATHER_WOOD,
        MINE_STONE,
        MINE_ORE,
        CRAFT,
        SMELT,
        GATHER_FOOD,
        DIG_DOWN,
        EXPLORE,
        NAVIGATE,
        COLLECT_DROPS,
        BUILD_SHELTER
    }

    record Task(
        String id,
        TaskKind kind,
        String target,     // recipe name, ore kind ("coal"|"iron"|"diamond"), smelt input ("raw_iron"|"raw_meat")
        int count,         // target total inventory count (or blocks/distance)
        BlockPos pos,      // optional explicit target coordinate
        boolean safeMode,  // safe staircase vs fast
        String source      // "model" or "local"
    ) {}

    record TaskReceipt(String id, String kind, String target, String outcome, String detail, int tick) {}

    private final MinecraftClient client;
    private final Motor motor;
    private final Perception perception;
    private final Pathfinder pathfinder;
    private final RouteExecutor route;
    private final GuiHands gui;
    private final SurvivalReflexes reflexes;
    private final String goal;

    private final ArrayDeque<Task> queue = new ArrayDeque<>();
    private final ArrayDeque<TaskReceipt> recentReceipts = new ArrayDeque<>();
    private final Set<BlockPos> blacklistedTargets = new HashSet<>();
    private final Set<Integer> ignoredDrops = new HashSet<>();
    private final java.util.Map<Integer, Integer> dropChaseCounts = new java.util.HashMap<>();

    private Task active;
    private int activeTicks;
    private int replanCooldown;
    private int noMineProgressTicks;
    private String statusText = "starting";
    private boolean safeExcavationMode = true;
    private int localSeq;

    // Task-specific transient state
    private BlockPos activeTargetBlock;
    private BlockPos placedTablePos;
    private BlockPos placedFurnacePos;
    private int smeltReadyTick = -1;
    private int smeltBatchSize;
    private boolean smeltLoaded;
    private boolean smeltCollecting;
    private BlockPos smeltChoreTarget;
    private int smeltChoreNoProgressTicks;
    private boolean recoveringWorkstation;
    private BlockPos workstationToRecover;
    private double exploreHeadingRad = 0.7;
    private int exploreFlipCount;
    private Vec3d exploreLastPos;
    private int exploreStuckTicks;
    private int dropChaseEntityId = -1;
    private int dropChaseTicks;
    private int rockBrokenCount;

    TaskRunner(MinecraftClient client, Motor motor, Perception perception,
               Pathfinder pathfinder, RouteExecutor route, GuiHands gui,
               SurvivalReflexes reflexes, String goal) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
        this.pathfinder = pathfinder;
        this.route = route;
        this.gui = gui;
        this.reflexes = reflexes;
        this.goal = goal;
    }

    void resetForLife() {
        queue.clear();
        active = null;
        activeTargetBlock = null;
        placedTablePos = null;
        placedFurnacePos = null;
        smeltLoaded = false;
        smeltCollecting = false;
        smeltReadyTick = -1;
        recoveringWorkstation = false;
        workstationToRecover = null;
        route.clear();
        gui.abort();
        blacklistedTargets.clear();
        ignoredDrops.clear();
        dropChaseCounts.clear();
        dropChaseEntityId = -1;
        dropChaseTicks = 0;
        noMineProgressTicks = 0;
    }

    void setSafeExcavationMode(boolean safe) { this.safeExcavationMode = safe; }
    boolean isSafeExcavationMode() { return safeExcavationMode; }
    String statusText() { return statusText; }
    Task activeTask() { return active; }
    List<Task> queuedTasks() { return new ArrayList<>(queue); }
    List<TaskReceipt> recentReceipts() { return new ArrayList<>(recentReceipts); }
    int rockBrokenCount() { return rockBrokenCount; }
    BlockPos activeSmeltFurnacePos() { return smeltLoaded ? placedFurnacePos : null; }
    int activeSmeltRemainingTicks(int currentTick) { return smeltLoaded ? Math.max(0, smeltReadyTick - currentTick) : 0; }

    /** Accept a new macro plan from the asynchronous LLM strategist without stalling! */
    void applyModelPlan(List<Task> tasks, boolean replaceQueue, Boolean safeMode) {
        if (safeMode != null) this.safeExcavationMode = safeMode;
        if (tasks == null || tasks.isEmpty()) return;
        if (replaceQueue) {
            queue.clear();
            // Interrupt active task cleanly when strategist explicitly replaces the queue (don't abort mid-GUI click or loaded furnace!)
            if (active != null && !gui.isBusy() && !smeltLoaded) {
                Task firstNew = tasks.get(0);
                boolean sameActive = active.kind() == firstNew.kind()
                    && java.util.Objects.equals(active.target(), firstNew.target())
                    && java.util.Objects.equals(active.pos(), firstNew.pos());
                if (!sameActive) {
                    finishActive("replaced", "superseded by model plan", 0);
                }
            }
        }
        for (Task t : tasks) {
            if (queue.size() < 8) queue.addLast(t);
        }
    }

    void tick(int currentTick) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null || !player.isAlive()) return;
        if (replanCooldown > 0) replanCooldown--;

        // 0. If GUI hands are currently active (crafting/furnace/hotbar swap), let GUI finish smoothly!
        if (gui.isBusy()) {
            gui.tick();
            statusText = "using inventory/workstation";
            return;
        }

        // 1. Always pick up reachable valuable dropped items right next to us (<= 6m, cumulative cap so jumping never resets it!)
        if (active != null) activeTicks++;
        if (active == null || (active.kind() != TaskKind.CRAFT && active.kind() != TaskKind.SMELT)) {
            ItemEntity nearbyValuable = findNearbyValuableDrop(player, 6.0);
            if (nearbyValuable != null) {
                int eid = nearbyValuable.getId();
                boolean highValue = isHighValueDrop(nearbyValuable.getStack().getItem());
                int maxChase = highValue ? 75 : 28;
                int total = dropChaseCounts.getOrDefault(eid, 0) + 1;
                dropChaseCounts.put(eid, total);
                if (total > maxChase || player.distanceTo(nearbyValuable) < 0.75) {
                    ignoredDrops.add(eid);
                    route.clear();
                } else if (highValue && (total > 12 || player.horizontalCollision)) {
                    // High-value drop (iron/diamond/workstation) may be inside a 1-block mining pocket:
                    // dig/pathfind cleanly into pickup range instead of walking into the wall!
                    Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, safeExcavationMode);
                    RouteExecutor.Status dst = navigateToward(player, Pathfinder.Goal.near(nearbyValuable.getBlockPos(), 1.0), opts, currentTick);
                    statusText = "retrieving " + nearbyValuable.getStack().getItem().getName().getString();
                    if (dst == RouteExecutor.Status.STUCK) {
                        ignoredDrops.add(eid);
                        route.clear();
                    }
                    return;
                } else {
                    motor.moveToward(nearbyValuable.getPos(), false, player.horizontalCollision, false, true);
                    statusText = "picking up " + nearbyValuable.getStack().getItem().getName().getString();
                    return;
                }
            }
        }

        // 2. If we finished crafting/smelting and want to pick up our temporary workstation, recover it cleanly
        if (recoveringWorkstation && workstationToRecover != null) {
            BlockState st = world.getBlockState(workstationToRecover);
            if (st.isAir() || (!st.isOf(Blocks.CRAFTING_TABLE) && !st.isOf(Blocks.FURNACE))) {
                recoveringWorkstation = false;
                workstationToRecover = null;
                route.clear();
            } else if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(workstationToRecover)) <= Motor.REACH_SQ) {
                motor.mineBlock(workstationToRecover, true);
                statusText = "picking up workstation";
                return;
            } else {
                navigateToward(player, Pathfinder.Goal.interactReach(workstationToRecover, 3.8),
                    Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f), currentTick);
                statusText = "approaching workstation to recover";
                return;
            }
        }

        // 3. Dequeue next task or pick smart local continuity step (ZERO pauses!)
        if (active == null) {
            active = queue.pollFirst();
            if (active == null) {
                active = planNextLocalTask(player);
            }
            activeTicks = 0;
            activeTargetBlock = null;
            smeltLoaded = false;
            smeltCollecting = false;
            route.clear();
        }

        if (active == null) {
            statusText = "goal complete";
            return;
        }

        int maxTicks = (active.kind() == TaskKind.MINE_ORE || active.kind() == TaskKind.DIG_DOWN) ? 6000 : 2400;
        if (activeTicks > maxTicks) {
            finishActive("timeout", "task exceeded time limit", currentTick);
            return;
        }

        // 4. Execute active task!
        switch (active.kind()) {
            case GATHER_WOOD -> tickGatherWood(player, world, currentTick);
            case MINE_STONE -> tickMineStone(player, world, currentTick);
            case MINE_ORE -> tickMineOre(player, world, currentTick);
            case CRAFT -> tickCraft(player, world, currentTick);
            case SMELT -> tickSmelt(player, world, currentTick);
            case GATHER_FOOD -> tickGatherFood(player, world, currentTick);
            case DIG_DOWN -> tickDigDown(player, world, currentTick);
            case EXPLORE -> tickExplore(player, world, currentTick);
            case NAVIGATE -> tickNavigate(player, world, currentTick);
            case COLLECT_DROPS -> tickCollectDrops(player, world, currentTick);
            case BUILD_SHELTER -> tickBuildShelter(player, world, currentTick);
        }
    }

    // ===================== TASK IMPLEMENTATIONS =====================

    private void tickGatherWood(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        int targetLogs = Math.max(1, active.count());
        int haveLogs = GuiHands.countLogs(player);
        int haveWoodEquiv = haveLogs + GuiHands.countPlanks(player) / 4;
        if (haveLogs >= targetLogs || (active.source().equals("local") && haveWoodEquiv >= targetLogs)) {
            finishActive("completed", "gathered " + haveLogs + " logs", currentTick);
            return;
        }

        // Check if standing on tree canopy leaves — if a log is right underneath or beside us, chop it!
        BlockPos feet = player.getBlockPos();
        if (activeTargetBlock == null || !world.getBlockState(activeTargetBlock).isIn(BlockTags.LOGS)) {
            activeTargetBlock = findBestLogTarget(player, world);
            route.clear();
        }

        boolean underground = world.getLightLevel(net.minecraft.world.LightType.SKY, feet) == 0;
        if (activeTargetBlock == null) {
            // If underground inside a cave/tunnel, climb/staircase back up to the surface instead of walking into stone walls!
            if (underground) {
                Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
                int surfaceY = Math.max(feet.getY() + 8, 66);
                navigateToward(player, Pathfinder.Goal.reachY(surfaceY), opts, currentTick);
                statusText = "climbing to surface for wood";
                return;
            }
            // If we spotted distant tree leaves (canopy up to 64m away), head toward those trees!
            BlockPos leaves = perception.nearestObserved(perception.observedLeaves(), feet, 64.0, blacklistedTargets);
            if (leaves != null && leaves.getSquaredDistance(feet) > 16.0) {
                exploreHeadingRad = Math.atan2(leaves.getZ() - feet.getZ(), leaves.getX() - feet.getX());
                walkDryHeading(player, world, exploreHeadingRad, currentTick, "heading toward visible trees");
                return;
            }
            // Smoothly look around & walk over dry land to spot trees!
            exploreForResources(player, world, currentTick, "searching for trees");
            return;
        }

        // Check if log is directly within reach!
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ) {
            boolean broken = motor.mineBlock(activeTargetBlock, true, false);
            statusText = "chopping wood";
            if (broken) {
                noMineProgressTicks = 0;
                activeTargetBlock = null;
            } else if (motor.breakingProgress() > 0.01f) {
                noMineProgressTicks = 0;
            } else if (++noMineProgressTicks > 45) {
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
                noMineProgressTicks = 0;
                route.clear();
            }
            return;
        }
        noMineProgressTicks = 0;

        // Navigate toward log (use mining pathfinder if underground so we can dig/staircase out to surface trees!)
        Pathfinder.Options opts = underground
            ? Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true)
            : Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f);
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.interactReach(activeTargetBlock, 3.6), opts, currentTick);
        statusText = "approaching tree";
        if (st == RouteExecutor.Status.STUCK) {
            blacklistedTargets.add(activeTargetBlock);
            activeTargetBlock = null;
        }
    }

    private BlockPos findBestLogTarget(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        // First check immediate reach for any observed log (including trunk below if on canopy!)
        BlockPos best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (BlockPos pos : perception.observedLogs()) {
            if (blacklistedTargets.contains(pos)) continue;
            // Verify if close enough to be in loaded memory
            if (pos.getSquaredDistance(feet) <= 25 && !world.getBlockState(pos).isIn(BlockTags.LOGS)) continue;
            // Skip very high canopy logs (>4 blocks above player) when lower ones exist
            int dy = pos.getY() - feet.getY();
            if (dy > 4) continue;
            double waterPenalty = 0.0;
            for (int d = 1; d <= 3; d++) {
                BlockState below = perception.getObserved(pos.getX(), pos.getY() - d, pos.getZ());
                if (below != null && !below.getFluidState().isEmpty()) {
                    waterPenalty = 14.0;
                    break;
                }
                if (below != null && Perception.isSolidSupport(below)) break;
            }
            double score = Math.sqrt(pos.getSquaredDistance(feet)) + Math.abs(dy) * 1.1 + waterPenalty;
            if (score < bestScore) {
                bestScore = score;
                best = pos;
            }
        }
        return best;
    }

    private void tickMineStone(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        int targetStone = Math.max(1, active.count());
        int have = GuiHands.countStone(player);
        if (have >= targetStone) {
            finishActive("completed", "collected " + have + " cobblestone", currentTick);
            return;
        }

        // Ensure a pickaxe is in hotbar!
        if (!ensureToolInHotbar(player, st -> st.getItem() instanceof net.minecraft.item.PickaxeItem)) {
            if (!hasAnyPickaxe(player)) {
                finishActive("failed", "no pickaxe carried", currentTick);
                return;
            }
            return; // hotbar swap in progress
        }

        // 1. Prefer any directly aimable stone within reach first, then nearest observed stone within 24 blocks!
        if (activeTargetBlock == null || !isStoneBlock(world.getBlockState(activeTargetBlock))) {
            activeTargetBlock = findBestStoneTarget(player, world);
            noMineProgressTicks = 0;
            route.clear();
        }

        if (activeTargetBlock != null) {
            if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ
                    && motor.findAimPoint(activeTargetBlock) != null) {
                boolean broken = motor.mineBlock(activeTargetBlock, true, true);
                statusText = "mining stone";
                if (broken) {
                    rockBrokenCount++;
                    noMineProgressTicks = 0;
                    activeTargetBlock = null;
                } else if (motor.breakingProgress() > 0.01f) {
                    noMineProgressTicks = 0;
                } else if (++noMineProgressTicks > 45) {
                    blacklistedTargets.add(activeTargetBlock);
                    activeTargetBlock = null;
                    noMineProgressTicks = 0;
                    route.clear();
                }
                return;
            }
            noMineProgressTicks = 0;
            Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
            RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.interactReach(activeTargetBlock, 3.4), opts, currentTick);
            statusText = "walking to stone";
            if (st == RouteExecutor.Status.COMPLETE) {
                // Within reach but occluded — chip away or reselect!
                if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ) {
                    boolean broken = motor.mineBlock(activeTargetBlock, true, true);
                    statusText = "mining stone";
                    if (broken) {
                        rockBrokenCount++;
                        activeTargetBlock = null;
                    } else if (motor.breakingProgress() > 0.01f) {
                        noMineProgressTicks = 0;
                    } else if (++noMineProgressTicks > 40) {
                        blacklistedTargets.add(activeTargetBlock);
                        activeTargetBlock = null;
                        noMineProgressTicks = 0;
                    }
                } else {
                    route.clear();
                }
            } else if (st == RouteExecutor.Status.STUCK) {
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
            }
            return;
        }

        // 2. No exposed stone spotted yet — ensure we're on DRY land before digging a staircase down!
        if (isWetSurfaceSpot(player, world)) {
            route.clear();
            exploreForResources(player, world, currentTick, "moving to dry ground before digging");
            return;
        }
        Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
        int goalY = Math.min(player.getBlockY() - 6, 56);
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.reachY(goalY), opts, currentTick);
        statusText = "digging down to stone";
        if (st == RouteExecutor.Status.STUCK) {
            // Try stepping forward and digging elsewhere
            exploreForResources(player, world, currentTick, "seeking diggable ground for stone");
        }
    }

    private void tickMineOre(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        Perception.OreKind oreKind = parseOreKind(active.target());
        Item dropItem = switch (oreKind) {
            case COAL -> Items.COAL;
            case IRON -> Items.RAW_IRON;
            case DIAMOND -> Items.DIAMOND;
        };
        int have = GuiHands.countItem(player, dropItem);
        // For iron, also count smelted iron ingots + iron pickaxe if local check
        if (oreKind == Perception.OreKind.IRON) {
            have += GuiHands.countItem(player, Items.IRON_INGOT);
        }
        if (have >= active.count()) {
            finishActive("completed", "collected " + have + " " + active.target(), currentTick);
            return;
        }

        // Verify required pickaxe tier is carried & in hotbar!
        int reqTier = switch (oreKind) {
            case COAL -> 1;    // wooden+
            case IRON -> 2;    // stone+
            case DIAMOND -> 3; // iron+
        };
        if (bestPickaxeTier(player) < reqTier) {
            finishActive("failed", "need higher tier pickaxe for " + active.target(), currentTick);
            return;
        }
        if (!ensureToolInHotbar(player, st -> pickaxeTier(st.getItem()) >= reqTier)) {
            return; // hotbar swap in progress
        }

        // Keep torches in hotbar when underground so RouteExecutor can light dark tunnels
        if ((player.getBlockY() < 64 || world.getLightLevel(net.minecraft.world.LightType.SKY, player.getBlockPos()) == 0)
                && GuiHands.countItem(player, Items.TORCH) > 0
                && motor.findHotbarItem(Items.TORCH) < 0) {
            if (!ensureToolInHotbar(player, st -> st.isOf(Items.TORCH))) {
                statusText = "moving torches to hotbar";
                return;
            }
        }

        // Pick target ore block: explicit pos (if not already mined/blacklisted), else same vein near active.pos(), else nearest ore!
        if (activeTargetBlock == null) {
            if (active.pos() != null && !blacklistedTargets.contains(active.pos())) {
                BlockState explicitObs = perception.getObserved(active.pos());
                if (explicitObs != null && !matchesOreBlock(explicitObs, oreKind)) {
                    perception.markOreRetired(active.pos());
                    blacklistedTargets.add(active.pos());
                } else {
                    activeTargetBlock = active.pos();
                }
            }
            if (activeTargetBlock == null) {
                BlockPos searchOrigin = (active.pos() != null && active.pos().getSquaredDistance(player.getBlockPos()) <= 16 * 16)
                    ? active.pos() : player.getBlockPos();
                List<BlockPos> cands = perception.nearestOreTargets(oreKind, searchOrigin, 6, blacklistedTargets);
                if (cands.isEmpty() && !searchOrigin.equals(player.getBlockPos())) {
                    cands = perception.nearestOreTargets(oreKind, player.getBlockPos(), 6, blacklistedTargets);
                }
                if (!cands.isEmpty()) {
                    activeTargetBlock = cands.get(0);
                }
            }
            route.clear();
        }

        // If we can already see the target block and it's NOT that ore anymore (already mined!), retire AND blacklist it!
        if (activeTargetBlock != null) {
            BlockState observed = perception.getObserved(activeTargetBlock);
            if (observed != null && !matchesOreBlock(observed, oreKind)) {
                perception.markOreRetired(activeTargetBlock);
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
                route.clear();
                statusText = "selecting next " + active.target() + " ore";
                return;
            }
        }

        if (activeTargetBlock == null) {
            // No known ore target — dig down toward the prime depth for this ore!
            int targetY = switch (oreKind) {
                case COAL -> 48;
                case IRON -> 16;
                case DIAMOND -> -54;
            };
            Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, safeExcavationMode);
            if (player.getBlockY() > targetY + 3) {
                navigateToward(player, Pathfinder.Goal.reachY(targetY), opts, currentTick);
                statusText = "descending to y=" + targetY + " for " + active.target();
            } else {
                // Branch mine straight ahead at optimal Y!
                BlockPos ahead = player.getBlockPos().add((int) Math.round(Math.cos(exploreHeadingRad) * 14), 0,
                    (int) Math.round(Math.sin(exploreHeadingRad) * 14));
                navigateToward(player, Pathfinder.Goal.near(ahead, 2.5), opts, currentTick);
                statusText = "branch mining for " + active.target();
            }
            return;
        }

        // Check if any matching observed ore is ALREADY within direct reach (mine veins cleanly!)
        BlockPos immediateOre = findImmediateReachableOre(player, world, oreKind);
        if (immediateOre != null) {
            // Check lava safety around ore before breaking
            if (perception.isNearKnownLava(immediateOre.getX(), immediateOre.getY(), immediateOre.getZ())) {
                blacklistedTargets.add(immediateOre);
                if (immediateOre.equals(activeTargetBlock)) activeTargetBlock = null;
                return;
            }
            boolean broken = motor.mineBlock(immediateOre, true);
            statusText = "mining " + active.target() + " ore";
            if (broken) {
                rockBrokenCount++;
                perception.markOreRetired(immediateOre);
                blacklistedTargets.add(immediateOre);
                if (immediateOre.equals(activeTargetBlock)) activeTargetBlock = null;
                dropChaseEntityId = -1;
                dropChaseTicks = 0;
            }
            return;
        }

        // Check if activeTargetBlock itself is ALREADY within direct reach!
        // Mine continuously every tick (chipping any occluding stone block in front if needed!) — NEVER stall in navigateToward!
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ) {
            if (perception.isNearKnownLava(activeTargetBlock.getX(), activeTargetBlock.getY(), activeTargetBlock.getZ())) {
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
                route.clear();
                return;
            }
            boolean broken = motor.mineBlock(activeTargetBlock, true, true);
            statusText = "mining " + active.target() + " ore";
            if (broken) {
                rockBrokenCount++;
                noMineProgressTicks = 0;
                perception.markOreRetired(activeTargetBlock);
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
                dropChaseEntityId = -1;
                dropChaseTicks = 0;
            } else if (motor.breakingProgress() > 0.01f) {
                noMineProgressTicks = 0;
            } else if (++noMineProgressTicks > 45) {
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
                noMineProgressTicks = 0;
                route.clear();
            }
            return;
        }
        noMineProgressTicks = 0;

        // Never start digging down into rock from inside water or a flooded swamp shoreline!
        if (activeTargetBlock.getY() < player.getBlockY() - 1 && isWetSurfaceSpot(player, world)) {
            route.clear();
            exploreForResources(player, world, currentTick, "moving to dry land before mining " + active.target());
            return;
        }

        // Navigate via 3D A* (with underground terrain hypotheses + safe staircase + torches!) right to the ore!
        Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, safeExcavationMode);
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.interactReach(activeTargetBlock, 3.4), opts, currentTick);
        int dy = activeTargetBlock.getY() - player.getBlockY();
        int dist = (int) Math.round(Math.sqrt(activeTargetBlock.getSquaredDistance(player.getBlockPos())));
        statusText = "mining route to " + active.target() + " (" + dist + "m, dy=" + dy + ")";
        if (st == RouteExecutor.Status.STUCK) {
            // If stuck on one target, defer it and try the next nearest ore!
            blacklistedTargets.add(activeTargetBlock);
            activeTargetBlock = null;
            route.clear();
        }
    }

    private BlockPos findBestStoneTarget(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        // 1. First look for any directly aimable stone block already within reach (not our own standing support!)
        BlockPos underFeet = feet.down();
        BlockPos bestImmediate = null;
        double bestImmDist = Double.POSITIVE_INFINITY;
        for (BlockPos pos : perception.observedStone()) {
            if (blacklistedTargets.contains(pos) || pos.equals(underFeet)) continue;
            double dSq = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos));
            if (dSq > Motor.REACH_SQ) continue;
            if (!isStoneBlock(world.getBlockState(pos))) continue;
            if (perception.isNearKnownLava(pos.getX(), pos.getY(), pos.getZ())) continue;
            if (motor.findAimPoint(pos) != null && dSq < bestImmDist) {
                bestImmDist = dSq;
                bestImmediate = pos;
            }
        }
        if (bestImmediate != null) return bestImmediate;
        // 2. Otherwise nearest observed stone within 24m
        return perception.nearestObserved(perception.observedStone(), feet, 24.0, blacklistedTargets);
    }

    private BlockPos findImmediateReachableOre(ClientPlayerEntity player, ClientWorld world, Perception.OreKind kind) {
        BlockPos feet = player.getBlockPos();
        BlockPos best = null;
        double bestDistSq = Motor.REACH_SQ;
        BlockPos.Mutable m = new BlockPos.Mutable();
        for (int dx = -4; dx <= 4; dx++) {
            for (int dy = -2; dy <= 4; dy++) {
                for (int dz = -4; dz <= 4; dz++) {
                    m.set(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz);
                    if (blacklistedTargets.contains(m)) continue;
                    BlockState st = world.getBlockState(m);
                    if (!matchesOreBlock(st, kind)) continue;
                    double dSq = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(m));
                    if (dSq < bestDistSq && motor.findAimPoint(m) != null) {
                        bestDistSq = dSq;
                        best = m.toImmutable();
                    }
                }
            }
        }
        return best;
    }

    private void tickCraft(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        GuiHands.RecipeId recipe = parseRecipe(active.target());
        if (recipe == null) {
            finishActive("failed", "unknown recipe " + active.target(), currentTick);
            return;
        }
        int desiredTotal = Math.max(1, active.count());
        if (recipe.output != null && GuiHands.countItem(player, recipe.output) >= desiredTotal) {
            // Keep crafting table placed if the very next queued task also needs a 3x3 table!
            Task next = queue.peekFirst();
            boolean nextNeedsTable = next != null && next.kind() == TaskKind.CRAFT
                && parseRecipe(next.target()) != null && parseRecipe(next.target()).needsTable;
            if (!nextNeedsTable && placedTablePos != null && world.getBlockState(placedTablePos).isOf(Blocks.CRAFTING_TABLE)) {
                workstationToRecover = placedTablePos;
                recoveringWorkstation = true;
                placedTablePos = null;
            }
            finishActive("completed", "crafted " + active.target(), currentTick);
            return;
        }
        if (recipe == GuiHands.RecipeId.PLANKS && GuiHands.countPlanks(player) >= desiredTotal) {
            finishActive("completed", "crafted planks", currentTick);
            return;
        }

        // Handle GUI outcome if we just finished a craft attempt
        if (gui.state() == GuiHands.State.DONE) {
            gui.abort();
            return; // re-check counts next tick (or proceed to next sub-step)
        }
        if (gui.state() == GuiHands.State.FAILED) {
            String reason = gui.failReason();
            gui.abort();
            finishActive("failed", "craft gui failed: " + reason, currentTick);
            return;
        }

        // Automatically craft missing wooden intermediates (planks / sticks / crafting_table) inline!
        if (needsPlanksFor(recipe, player)) {
            if (GuiHands.countLogs(player) <= 0) {
                finishActive("failed", "need logs to craft " + active.target(), currentTick);
                return;
            }
            gui.startCraft(GuiHands.RecipeId.PLANKS, Math.min(GuiHands.countLogs(player), 4));
            statusText = "crafting planks";
            return;
        }
        if (needsSticksFor(recipe, player)) {
            if (GuiHands.countPlanks(player) < 2) {
                if (GuiHands.countLogs(player) > 0) {
                    gui.startCraft(GuiHands.RecipeId.PLANKS, 1);
                    statusText = "crafting planks for sticks";
                    return;
                }
                finishActive("failed", "need planks for sticks", currentTick);
                return;
            }
            gui.startCraft(GuiHands.RecipeId.STICK, 1);
            statusText = "crafting sticks";
            return;
        }

        // For 3x3 recipes: ensure a crafting table is placed nearby & open!
        if (recipe.needsTable) {
            BlockPos table = findNearbyWorkstation(player, world, Blocks.CRAFTING_TABLE, 10.0);
            if (table == null) {
                // Need to craft or place a crafting table!
                if (GuiHands.countItem(player, Items.CRAFTING_TABLE) <= 0) {
                    if (GuiHands.countPlanks(player) < 4) {
                        if (GuiHands.countLogs(player) > 0) {
                            gui.startCraft(GuiHands.RecipeId.PLANKS, 1);
                            statusText = "crafting planks for table";
                            return;
                        }
                        finishActive("failed", "need planks for crafting table", currentTick);
                        return;
                    }
                    gui.startCraft(GuiHands.RecipeId.CRAFTING_TABLE, 1);
                    statusText = "crafting crafting_table";
                    return;
                }
                // Place carried crafting table!
                if (!ensureToolInHotbar(player, st -> st.isOf(Items.CRAFTING_TABLE))) return;
                int slot = motor.findHotbarItem(Items.CRAFTING_TABLE);
                BlockPos spot = findPlacementSpotNearPlayer(player, world);
                if (spot == null) {
                    if (clearAlcoveForWorkstation(player, world)) {
                        statusText = "clearing space for crafting table";
                        return;
                    }
                    exploreForResources(player, world, currentTick, "finding space to place crafting table");
                    return;
                }
                if (motor.placeBlockAt(spot, slot)) {
                    placedTablePos = spot;
                    perception.recordObserved(spot, Blocks.CRAFTING_TABLE.getDefaultState(), false);
                }
                statusText = "placing crafting table";
                return;
            }

            // Walk into reach of the crafting table and open it!
            if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(table)) > Motor.REACH_SQ) {
                navigateToward(player, Pathfinder.Goal.interactReach(table, 3.3),
                    Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f), currentTick);
                statusText = "walking to crafting table";
                return;
            }
            if (!(client.currentScreen instanceof CraftingScreen)) {
                motor.interactBlock(table);
                statusText = "opening crafting table";
                return;
            }
        }

        // Compute how many executions to run
        int haveNow = recipe == GuiHands.RecipeId.PLANKS ? GuiHands.countPlanks(player)
            : (recipe.output != null ? GuiHands.countItem(player, recipe.output) : 0);
        int missing = Math.max(1, desiredTotal - haveNow);
        int execs = Math.max(1, (missing + recipe.batch - 1) / recipe.batch);
        gui.startCraft(recipe, execs);
        statusText = "crafting " + active.target();
    }

    private void tickSmelt(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        Item inputItem = "raw_meat".equals(active.target()) ? findBestRawMeat(player) : Items.RAW_IRON;
        Item outputItem = inputItem == Items.RAW_IRON ? Items.IRON_INGOT : cookedOf(inputItem);
        int targetOut = Math.max(1, active.count());

        if (outputItem != null && GuiHands.countItem(player, outputItem) >= targetOut && !smeltLoaded) {
            if (placedFurnacePos != null && world.getBlockState(placedFurnacePos).isOf(Blocks.FURNACE)) {
                workstationToRecover = placedFurnacePos;
                recoveringWorkstation = true;
                placedFurnacePos = null;
            }
            finishActive("completed", "smelted " + outputItem.getName().getString(), currentTick);
            return;
        }

        if (gui.state() == GuiHands.State.DONE) {
            gui.abort();
            if (smeltCollecting) {
                smeltCollecting = false;
                smeltLoaded = false;
                int nowOut = outputItem == null ? 0 : GuiHands.countItem(player, outputItem);
                int remIn = inputItem == null ? 0 : GuiHands.countItem(player, inputItem);
                if (nowOut >= targetOut || remIn <= 0) {
                    if (placedFurnacePos != null && world.getBlockState(placedFurnacePos).isOf(Blocks.FURNACE)) {
                        workstationToRecover = placedFurnacePos;
                        recoveringWorkstation = true;
                        placedFurnacePos = null;
                    }
                    finishActive(nowOut >= targetOut ? "completed" : "partial",
                        "collected " + nowOut + " " + (outputItem == null ? "items" : outputItem.getName().getString()), currentTick);
                }
            } else {
                smeltLoaded = true;
                smeltReadyTick = currentTick + Math.max(1, smeltBatchSize) * 205 + 20;
            }
            return;
        }
        if (gui.state() == GuiHands.State.FAILED) {
            String reason = gui.failReason();
            gui.abort();
            finishActive("failed", "furnace gui failed: " + reason, currentTick);
            return;
        }

        // Find or place a furnace!
        BlockPos furnace = findNearbyWorkstation(player, world, Blocks.FURNACE, 14.0);
        if (furnace == null) {
            if (GuiHands.countItem(player, Items.FURNACE) <= 0) {
                finishActive("failed", "no furnace carried", currentTick);
                return;
            }
            if (!ensureToolInHotbar(player, st -> st.isOf(Items.FURNACE))) return;
            int slot = motor.findHotbarItem(Items.FURNACE);
            BlockPos spot = findPlacementSpotNearPlayer(player, world);
            if (spot == null) {
                if (clearAlcoveForWorkstation(player, world)) {
                    statusText = "clearing space for furnace";
                    return;
                }
                exploreForResources(player, world, currentTick, "finding space for furnace");
                return;
            }
            if (motor.placeBlockAt(spot, slot)) {
                placedFurnacePos = spot;
                perception.recordObserved(spot, Blocks.FURNACE.getDefaultState(), false);
            }
            statusText = "placing furnace";
            return;
        }

        // While smelting: if >7s remain and healthy, do productive nearby work within ~11m of the furnace
        // (mine nearby coal/iron ore, chop nearby logs, or mine nearby stone/widen workspace), then return in time!
        if (smeltLoaded && currentTick < smeltReadyTick) {
            int remTicks = smeltReadyTick - currentTick;
            double distToFurnaceSq = player.getBlockPos().getSquaredDistance(furnace);
            boolean canDoProductiveChore = remTicks > 140
                && player.getHealth() >= 13.0f
                && perception.visibleHostiles().isEmpty()
                && distToFurnaceSq <= 12.0 * 12.0;

            if (canDoProductiveChore && doProductiveSmeltChore(player, world, furnace, currentTick, remTicks)) {
                return;
            }

            // Otherwise (<= 7s left, low HP, or no useful chore nearby): walk back to furnace & watch attentively!
            smeltChoreTarget = null;
            if (distToFurnaceSq > 3.8 * 3.8) {
                navigateToward(player, Pathfinder.Goal.interactReach(furnace, 3.2),
                    Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true), currentTick);
                statusText = "returning to furnace (" + Math.max(0, remTicks / 20) + "s)";
                return;
            }
            float scanYaw = (float) (player.getYaw() + Math.sin(currentTick * 0.04) * 18.0);
            motor.lookAtAngles(scanYaw, 2.0f, Motor.LookMode.SCAN);
            statusText = "waiting for furnace (" + Math.max(0, remTicks / 20) + "s)";
            return;
        }
        smeltChoreTarget = null;

        // Walk into reach of furnace and open it!
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(furnace)) > Motor.REACH_SQ) {
            navigateToward(player, Pathfinder.Goal.interactReach(furnace, 3.3),
                Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f), currentTick);
            statusText = "walking to furnace";
            return;
        }
        if (!(client.currentScreen instanceof FurnaceScreen)) {
            motor.interactBlock(furnace);
            statusText = "opening furnace";
            return;
        }

        if (smeltLoaded) {
            smeltCollecting = true;
            gui.startFurnaceCollect();
            statusText = "collecting smelted items";
        } else {
            if (inputItem == null || GuiHands.countItem(player, inputItem) <= 0) {
                finishActive("failed", "no smelt input carried", currentTick);
                return;
            }
            int toSmelt = Math.min(GuiHands.countItem(player, inputItem),
                Math.max(1, targetOut - (outputItem == null ? 0 : GuiHands.countItem(player, outputItem))));
            smeltBatchSize = toSmelt;
            gui.startFurnaceLoad(inputItem, toSmelt);
            statusText = "loading furnace";
        }
    }

    private void tickGatherFood(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        int wantFood = Math.max(2, active.count());
        if (GuiHands.countEdibleFood(player, true) >= wantFood) {
            finishActive("completed", "gathered food", currentTick);
            return;
        }

        // 1. Check visible sweet berry bushes first (quick, safe food!)
        BlockPos berry = perception.nearestObserved(perception.observedBerries(), player.getBlockPos(), 20.0, blacklistedTargets);
        if (berry != null) {
            if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(berry)) <= Motor.REACH_SQ) {
                motor.interactBlock(berry);
                statusText = "harvesting sweet berries";
                return;
            }
            navigateToward(player, Pathfinder.Goal.interactReach(berry, 3.4),
                Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f), currentTick);
            statusText = "walking to berry bush";
            return;
        }

        // 2. Hunt nearest visible passive food animal!
        List<AnimalEntity> animals = perception.visibleFoodAnimals();
        if (!animals.isEmpty()) {
            AnimalEntity quarry = animals.get(0);
            motor.selectBestWeapon();
            if (player.distanceTo(quarry) <= 3.3) {
                motor.attackEntity(quarry);
                motor.moveToward(quarry.getPos(), false, player.horizontalCollision, false, false);
            } else {
                motor.moveToward(quarry.getPos(), true, player.horizontalCollision, false, true);
            }
            statusText = "hunting " + quarry.getType().getName().getString();
            return;
        }

        // 3. Explore surface to find food animals/berries (bounded so we don't starve wandering forever!)
        if (activeTicks > 500) {
            finishActive("partial", "no food animals spotted nearby", currentTick);
            return;
        }
        exploreForResources(player, world, currentTick, "looking for food");
    }

    private void tickDigDown(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        int targetY = active.pos() != null ? active.pos().getY() : active.count();
        if (player.getBlockY() <= targetY) {
            finishActive("completed", "reached y=" + player.getBlockY(), currentTick);
            return;
        }
        if (isWetSurfaceSpot(player, world)) {
            route.clear();
            exploreForResources(player, world, currentTick, "moving to dry land before descending");
            return;
        }
        Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, active.safeMode());
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.reachY(targetY), opts, currentTick);
        statusText = "digging staircase to y=" + targetY;
        if (st == RouteExecutor.Status.STUCK) {
            finishActive("partial", "stuck digging down at y=" + player.getBlockY(), currentTick);
        }
    }

    private void tickExplore(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (activeTicks > 300) {
            finishActive("completed", "explored terrain", currentTick);
            return;
        }
        exploreForResources(player, world, currentTick, "exploring surroundings");
    }

    private void tickNavigate(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (active.pos() == null) {
            finishActive("failed", "missing destination", currentTick);
            return;
        }
        double range = Math.max(1.5, active.count() > 0 ? active.count() : 2.5);
        if (player.getBlockPos().getSquaredDistance(active.pos()) <= range * range) {
            finishActive("completed", "arrived at destination", currentTick);
            return;
        }
        Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, safeExcavationMode);
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.near(active.pos(), range), opts, currentTick);
        statusText = "navigating to " + active.pos().toShortString();
        if (st == RouteExecutor.Status.STUCK) {
            finishActive("failed", "route stuck", currentTick);
        }
    }

    private void tickCollectDrops(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        List<ItemEntity> drops = perception.visibleDrops();
        if (drops.isEmpty() || activeTicks > 180) {
            finishActive("completed", "collected drops", currentTick);
            return;
        }
        ItemEntity nearest = drops.get(0);
        motor.moveToward(nearest.getPos(), player.distanceTo(nearest) > 4.0, player.horizontalCollision, false, true);
        statusText = "collecting drops";
    }

    private void tickBuildShelter(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (Motor.countShelterBlocks(player) <= 0) {
            finishActive("failed", "no shelter blocks carried", currentTick);
            return;
        }
        if (activeTicks <= 2) {
            int holdSec = active.count() > 0 ? Math.min(30, active.count()) : 10;
            reflexes.requestManualShelter(holdSec * 20);
            statusText = "starting emergency shelter";
            return;
        }
        if (!reflexes.inShelter()) {
            finishActive(reflexes.shelterEverSealed() ? "completed" : "partial",
                reflexes.shelterEverSealed() ? "built and exited shelter" : "shelter build ended", currentTick);
            return;
        }
        statusText = "building shelter";
    }

    // ===================== SMART LOCAL CONTINUITY PLANNER =====================

    /**
     * Produces the next logical survival task whenever the LLM queue is empty,
     * guaranteeing ZERO idle pauses during model latency or model-free play!
     */
    private Task planNextLocalTask(ClientPlayerEntity player) {
        int logs = GuiHands.countLogs(player);
        int planks = GuiHands.countPlanks(player);
        int sticks = GuiHands.countItem(player, Items.STICK);
        int stone = GuiHands.countStone(player);
        int rawIron = GuiHands.countItem(player, Items.RAW_IRON);
        int ironIngots = GuiHands.countItem(player, Items.IRON_INGOT);
        int coal = GuiHands.countItem(player, Items.COAL) + GuiHands.countItem(player, Items.CHARCOAL);
        int torches = GuiHands.countItem(player, Items.TORCH);
        int diamonds = GuiHands.countItem(player, Items.DIAMOND);
        int pickTier = bestPickaxeTier(player);
        boolean hasTable = GuiHands.countItem(player, Items.CRAFTING_TABLE) > 0
            || findNearbyWorkstation(player, client.world, Blocks.CRAFTING_TABLE, 10.0) != null;
        boolean hasFurnace = GuiHands.countItem(player, Items.FURNACE) > 0
            || findNearbyWorkstation(player, client.world, Blocks.FURNACE, 12.0) != null;

        // 0. If injured or hungry with no food on surface, grab quick visible food!
        if ((player.getHealth() < 12f || player.getHungerManager().getFoodLevel() <= 10)
                && GuiHands.countEdibleFood(player, true) == 0
                && (!perception.visibleFoodAnimals().isEmpty() || !perception.observedBerries().isEmpty())) {
            return localTask(TaskKind.GATHER_FOOD, "food", 4, null);
        }

        // 1. Early wood & wooden pickaxe
        if (pickTier < 1) {
            int woodEquiv = logs * 4 + planks;
            if (woodEquiv < 12) return localTask(TaskKind.GATHER_WOOD, "logs", 4, null);
            if (!hasTable) return localTask(TaskKind.CRAFT, "crafting_table", 1, null);
            return localTask(TaskKind.CRAFT, "wooden_pickaxe", 1, null);
        }
        if ("wooden_pickaxe".equals(goal)) return null;

        // 2. Cobblestone & stone pickaxe (+ furnace & stone sword!)
        if (pickTier < 2) {
            if (stone < 3) return localTask(TaskKind.MINE_STONE, "stone", 14, null);
            if (logs * 4 + planks + sticks < 4) return localTask(TaskKind.GATHER_WOOD, "logs", 3, null);
            return localTask(TaskKind.CRAFT, "stone_pickaxe", 1, null);
        }
        if ("stone_pickaxe".equals(goal)) return null;

        // 3. Preparation before going deep underground: furnace, stone sword, spare wood, torches
        if (!hasFurnace && rawIron + ironIngots < 3) {
            if (stone < 8) return localTask(TaskKind.MINE_STONE, "stone", 12, null);
            return localTask(TaskKind.CRAFT, "furnace", 1, null);
        }
        if (GuiHands.countItem(player, Items.STONE_SWORD) == 0 && GuiHands.countItem(player, Items.IRON_SWORD) == 0
                && stone >= 2 && (logs * 4 + planks + sticks >= 2)) {
            return localTask(TaskKind.CRAFT, "stone_sword", 1, null);
        }
        if (torches < 4 && coal >= 2 && (logs * 4 + planks + sticks >= 2)) {
            return localTask(TaskKind.CRAFT, "torch", 8, null);
        }

        // 4. Iron ore -> smelt -> iron pickaxe
        if (pickTier < 3) {
            if (ironIngots >= 3) {
                if (logs * 4 + planks + sticks < 2) return localTask(TaskKind.GATHER_WOOD, "logs", 2, null);
                return localTask(TaskKind.CRAFT, "iron_pickaxe", 1, null);
            }
            if (rawIron + ironIngots >= 3) {
                if (!hasFurnace) {
                    if (stone < 8) return localTask(TaskKind.MINE_STONE, "stone", 8, null);
                    return localTask(TaskKind.CRAFT, "furnace", 1, null);
                }
                if (GuiHands.countFuelUnits(player) < 3) {
                    if (coal == 0 && !perception.nearestOreTargets(Perception.OreKind.COAL, player.getBlockPos(), 1, blacklistedTargets).isEmpty()) {
                        return localTask(TaskKind.MINE_ORE, "coal", 4, null);
                    }
                    return localTask(TaskKind.GATHER_WOOD, "logs", 3, null);
                }
                return localTask(TaskKind.SMELT, "raw_iron", 3, null);
            }
            // Grab a bit of coal first if very close, then mine iron ore!
            if (coal < 3 && torches < 4) {
                List<BlockPos> nearCoal = perception.nearestOreTargets(Perception.OreKind.COAL, player.getBlockPos(), 1, blacklistedTargets);
                if (!nearCoal.isEmpty() && nearCoal.get(0).getSquaredDistance(player.getBlockPos()) < 22 * 22) {
                    return localTask(TaskKind.MINE_ORE, "coal", 4, nearCoal.get(0));
                }
            }
            return localTask(TaskKind.MINE_ORE, "iron", 4, null);
        }
        if ("iron_pickaxe".equals(goal)) return null;

        // 5. Diamonds -> diamond pickaxe!
        int needDiamonds = "diamond".equals(goal) ? 1 : 3;
        if (diamonds < needDiamonds) {
            // Keep a spare stone pickaxe for digging down through hundreds of blocks of stone so iron pickaxe stays fresh!
            if (GuiHands.countItem(player, Items.STONE_PICKAXE) == 0 && stone >= 3 && (logs * 4 + planks + sticks >= 2)) {
                return localTask(TaskKind.CRAFT, "stone_pickaxe", 1, null);
            }
            // Keep torches handy for dark underground tunnels
            if (torches < 4 && coal >= 1 && (logs * 4 + planks + sticks >= 2)) {
                return localTask(TaskKind.CRAFT, "torch", 8, null);
            }
            // Always keep at least 2 sticks (or wood to craft them) before descending for diamonds!
            if (sticks < 2 && planks < 2 && logs == 0) {
                return localTask(TaskKind.GATHER_WOOD, "logs", 3, null);
            }
            return localTask(TaskKind.MINE_ORE, "diamond", needDiamonds, null);
        }
        if ("diamond".equals(goal)) return null;

        if ("diamond_pickaxe".equals(goal)) {
            if (GuiHands.countItem(player, Items.DIAMOND_PICKAXE) < 1) {
                if (sticks < 2 && planks < 2 && logs == 0) {
                    return localTask(TaskKind.GATHER_WOOD, "logs", 2, null);
                }
                return localTask(TaskKind.CRAFT, "diamond_pickaxe", 1, null);
            }
            return null;
        }

        return localTask(TaskKind.EXPLORE, "explore", 16, null);
    }

    private Task localTask(TaskKind kind, String target, int count, BlockPos pos) {
        localSeq++;
        return new Task("local-" + localSeq, kind, target, count, pos, safeExcavationMode, "local");
    }

    // ===================== NAVIGATION & HELPERS =====================

    private RouteExecutor.Status navigateToward(ClientPlayerEntity player, Pathfinder.Goal navGoal,
                                                Pathfinder.Options opts, int currentTick) {
        if (!route.hasPlan()) {
            if (replanCooldown > 0) return RouteExecutor.Status.RUNNING;
            Pathfinder.Plan plan = pathfinder.search(perception, player, player.getBlockPos(), navGoal, opts);
            if (plan.isEmpty()) {
                if (plan.complete()) return RouteExecutor.Status.COMPLETE;
                replanCooldown = 6;
                return RouteExecutor.Status.STUCK;
            }
            replanCooldown = 6;
            route.setPlan(plan);
        }
        RouteExecutor.Status st = route.tick(currentTick, true);
        if (st == RouteExecutor.Status.INVALIDATED) {
            replanCooldown = 0; // immediately replan on next tick!
            return RouteExecutor.Status.RUNNING;
        }
        if (st == RouteExecutor.Status.COMPLETE && !route.currentPlan().complete()) {
            // Partial segment finished — seamlessly plan next segment!
            route.clear();
            replanCooldown = 0;
            return RouteExecutor.Status.RUNNING;
        }
        return st;
    }

    private void exploreForResources(ClientPlayerEntity player, ClientWorld world, int currentTick, String label) {
        statusText = label;
        BlockPos feet = player.getBlockPos();

        // 1. If in water, climb out onto a reachable low dry shore (dy 0..1), or swim along open water / carve a step out if walled in!
        if (player.isTouchingWater()) {
            Vec3d wPos = player.getPos();
            if (exploreLastPos == null || Math.hypot(wPos.x - exploreLastPos.x, wPos.z - exploreLastPos.z) > 1.2) {
                exploreLastPos = wPos;
                exploreStuckTicks = 0;
            } else {
                exploreStuckTicks++;
            }

            BlockPos dryShore = findNearestDryShore(player, world);
            if (exploreStuckTicks >= 32) {
                if (dryShore != null) blacklistedTargets.add(dryShore);
                // Steep stone/dirt wall blocking water exit: carve a step if diggable, or turn along open water!
                BlockPos aheadWall = BlockPos.ofFloored(
                    player.getX() + Math.cos(exploreHeadingRad) * 1.15,
                    player.getY() + 1.0,
                    player.getZ() + Math.sin(exploreHeadingRad) * 1.15);
                BlockState wallSt = world.getBlockState(aheadWall);
                if (!wallSt.isAir() && wallSt.getFluidState().isEmpty() && !Perception.isUnbreakable(wallSt)
                        && !Perception.isHazardBlock(wallSt) && bestPickaxeTier(player) >= 1) {
                    motor.mineBlock(aheadWall, true, true);
                    motor.moveToward(Vec3d.ofBottomCenter(aheadWall), false, true, false, false);
                    statusText = "carving exit out of water";
                    if (exploreStuckTicks > 95) {
                        exploreHeadingRad = pickOpenWaterHeading(player, world, exploreHeadingRad);
                        exploreStuckTicks = 0;
                        exploreLastPos = wPos;
                    }
                    return;
                }
                exploreHeadingRad = pickOpenWaterHeading(player, world, exploreHeadingRad);
                exploreStuckTicks = 0;
                exploreLastPos = wPos;
                dryShore = findNearestDryShore(player, world);
            }

            if (dryShore != null) {
                exploreHeadingRad = Math.atan2(dryShore.getZ() + 0.5 - player.getZ(), dryShore.getX() + 0.5 - player.getX());
                motor.moveToward(Vec3d.ofBottomCenter(dryShore), false, true, false, true);
                statusText = "climbing out of water";
                return;
            }
            // Open water: keep ONE steady open-water heading (never splash into a vertical cliff!)
            Vec3d target = player.getPos().add(Math.cos(exploreHeadingRad) * 12.0, 0, Math.sin(exploreHeadingRad) * 12.0);
            motor.moveToward(target, false, true, false, true);
            statusText = "swimming toward land";
            return;
        }

        // 2. If standing on canopy leaves, look for dry ground or water below and drop safely!
        if (world.getBlockState(feet.down()).getBlock() instanceof LeavesBlock) {
            BlockPos dropTarget = findSafeCanopyExit(player, world);
            if (dropTarget != null) {
                motor.moveToward(Vec3d.ofBottomCenter(dropTarget), false, false, false, true);
                return;
            }
        }

        // 3. Track horizontal exploration progress so we NEVER jam against a 2-block hillside/corner!
        Vec3d curPos = player.getPos();
        if (exploreLastPos == null || Math.hypot(curPos.x - exploreLastPos.x, curPos.z - exploreLastPos.z) > 1.4) {
            exploreLastPos = curPos;
            exploreStuckTicks = 0;
        } else {
            exploreStuckTicks++;
        }

        boolean stuck = exploreStuckTicks >= 30;
        boolean headingBad = isHeadingIntoWaterOrWall(player, world, exploreHeadingRad);
        if (stuck) {
            // Force a decisive turn away from the jammed heading and avoid re-picking the same wall!
            exploreFlipCount++;
            double turnOffset = (exploreFlipCount % 2 == 1 ? 1.0 : -1.0) * (Math.PI * 0.62 + (exploreFlipCount % 3) * 0.25);
            exploreHeadingRad = pickBestDryHeading(player, world, exploreHeadingRad + turnOffset, true);
            exploreStuckTicks = 0;
            exploreLastPos = curPos;
        } else if (activeTicks <= 2 || headingBad || activeTicks % 180 == 0 || player.horizontalCollision) {
            exploreHeadingRad = pickBestDryHeading(player, world, exploreHeadingRad, headingBad || player.horizontalCollision);
        }

        walkDryHeading(player, world, exploreHeadingRad, currentTick, label);
    }

    private void walkDryHeading(ClientPlayerEntity player, ClientWorld world, double headingRad, int currentTick, String label) {
        statusText = label;
        if (player.isTouchingWater()) {
            BlockPos shore = findNearestDryShore(player, world);
            if (shore != null) {
                motor.moveToward(Vec3d.ofBottomCenter(shore), false, true, false, true);
                return;
            }
        }
        double dx = Math.cos(headingRad);
        double dz = Math.sin(headingRad);
        Vec3d target = player.getPos().add(dx * 10.0, 0, dz * 10.0);

        // Proactive jump over 1-block solid ledges right ahead so sprinting over hills is fluid!
        BlockPos aheadFeet = BlockPos.ofFloored(player.getX() + dx * 0.95, player.getY(), player.getZ() + dz * 0.95);
        boolean stepUpAhead = Perception.isSolidSupport(world.getBlockState(aheadFeet))
            && Perception.isPassable(world.getBlockState(aheadFeet.up()))
            && Perception.isPassable(world.getBlockState(aheadFeet.up(2)));
        boolean jump = stepUpAhead || player.horizontalCollision || player.isTouchingWater();

        // Gently pan gaze left/right (+/- 28 deg) while sprinting forward to scan horizon for forests/caves
        float moveYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float scanOffset = (float) (Math.sin(currentTick * 0.055) * 28.0);
        motor.lookAtAngles(moveYaw + scanOffset, 3.0f, Motor.LookMode.NORMAL);
        motor.moveToward(target, !player.isTouchingWater(), jump, false, false);
    }

    private boolean isHeadingIntoWaterOrWall(ClientPlayerEntity player, ClientWorld world, double rad) {
        double dx = Math.cos(rad);
        double dz = Math.sin(rad);
        int by = player.getBlockY();
        // Immediate 1-2 block steep wall check (cannot walk or 1-block jump over a 2-high solid wall!)
        for (double dist = 1.0; dist <= 2.2; dist += 1.0) {
            int bx = (int) Math.floor(player.getX() + dx * dist);
            int bz = (int) Math.floor(player.getZ() + dz * dist);
            BlockState atFeet = world.getBlockState(new BlockPos(bx, by, bz));
            BlockState atHead = world.getBlockState(new BlockPos(bx, by + 1, bz));
            if (!Perception.isPassable(atFeet) && !Perception.isPassable(atHead)) return true;
        }
        for (int dist = 2; dist <= 6; dist += 2) {
            int bx = (int) Math.floor(player.getX() + dx * dist);
            int bz = (int) Math.floor(player.getZ() + dz * dist);
            for (int dy = 1; dy >= -3; dy--) {
                BlockState st = perception.getObserved(bx, by + dy, bz);
                if (st == null) continue;
                if (!st.getFluidState().isEmpty()) return true;
                if (Perception.isSolidSupport(st)) {
                    // Steep wall >= 2 blocks high right ahead?
                    if (dy >= 1 && Perception.isSolidSupport(perception.getObserved(bx, by + dy + 1, bz))) return true;
                    break;
                }
            }
        }
        return false;
    }

    private double pickBestDryHeading(ClientPlayerEntity player, ClientWorld world, double currentRad, boolean avoidCurrent) {
        double bestRad = currentRad;
        double bestScore = Double.NEGATIVE_INFINITY;
        int by = player.getBlockY();
        for (int i = 0; i < 12; i++) {
            double rad = currentRad + (i * Math.PI * 2.0 / 12.0);
            double dx = Math.cos(rad);
            double dz = Math.sin(rad);
            // Continuity preference unless we're explicitly escaping a blocked heading
            double score = avoidCurrent ? -Math.cos(rad - currentRad) * 6.0 : Math.cos(rad - currentRad) * 3.0;

            // Check immediate 1..2 block passability (walls >= 2 blocks high get strongly penalized!)
            boolean blockedClose = false;
            for (double d = 1.0; d <= 2.2; d += 1.0) {
                int bx = (int) Math.floor(player.getX() + dx * d);
                int bz = (int) Math.floor(player.getZ() + dz * d);
                BlockState f = world.getBlockState(new BlockPos(bx, by, bz));
                BlockState h = world.getBlockState(new BlockPos(bx, by + 1, bz));
                BlockState h2 = world.getBlockState(new BlockPos(bx, by + 2, bz));
                if (!Perception.isPassable(f) && !Perception.isPassable(h)) {
                    score -= 45.0;
                    blockedClose = true;
                    break;
                }
                if (!Perception.isPassable(f) && !Perception.isPassable(h2)) {
                    score -= 30.0; // cannot jump up onto 1-block ledge due to low ceiling
                    blockedClose = true;
                    break;
                }
            }
            if (blockedClose) {
                if (score > bestScore) { bestScore = score; bestRad = rad; }
                continue;
            }

            for (int dist = 2; dist <= 14; dist += 2) {
                int bx = (int) Math.floor(player.getX() + dx * dist);
                int bz = (int) Math.floor(player.getZ() + dz * dist);
                for (int dy = 2; dy >= -4; dy--) {
                    BlockState st = perception.getObserved(bx, by + dy, bz);
                    if (st == null) continue;
                    if (!st.getFluidState().isEmpty()) {
                        score -= 18.0; // strongly avoid ocean/rivers!
                        break;
                    }
                    if (Perception.isSolidSupport(st)) {
                        // Reward walkable dry terrain (dy in -2..+1); penalize steep unreachable cliff faces (dy >= 2)
                        if (dy >= 2) {
                            score -= 10.0;
                        } else {
                            score += 5.0;
                        }
                        break;
                    }
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestRad = rad;
            }
        }
        return bestRad;
    }

    /** True when player is in water or on a flooded surface shoreline (bad place to start digging down!). */
    private boolean isWetSurfaceSpot(ClientPlayerEntity player, ClientWorld world) {
        if (player.isTouchingWater() || player.isSubmergedInWater()) return true;
        BlockPos feet = player.getBlockPos();
        if (feet.getY() < 56 || world.getLightLevel(net.minecraft.world.LightType.SKY, feet) == 0) {
            return false; // already safely underground below sea level
        }
        int wetNeighbors = 0;
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                if (!world.getFluidState(feet.add(dx, 0, dz)).isEmpty()
                        || !world.getFluidState(feet.add(dx, -1, dz)).isEmpty()) {
                    wetNeighbors++;
                    if (wetNeighbors >= 3) return true;
                }
            }
        }
        return false;
    }

    private double pickOpenWaterHeading(ClientPlayerEntity player, ClientWorld world, double currentRad) {
        double bestRad = currentRad + Math.PI * 0.75;
        double bestScore = Double.NEGATIVE_INFINITY;
        int by = player.getBlockY();
        for (int i = 0; i < 12; i++) {
            double rad = currentRad + (i * Math.PI * 2.0 / 12.0);
            double dx = Math.cos(rad);
            double dz = Math.sin(rad);
            // Strongly turn away from the jammed wall direction
            double score = -Math.cos(rad - currentRad) * 5.0;
            for (int dist = 1; dist <= 6; dist++) {
                int bx = (int) Math.floor(player.getX() + dx * dist);
                int bz = (int) Math.floor(player.getZ() + dz * dist);
                BlockState atWater = world.getBlockState(new BlockPos(bx, by, bz));
                BlockState above = world.getBlockState(new BlockPos(bx, by + 1, bz));
                if (!Perception.isPassable(above)) {
                    score -= 22.0; // vertical wall rising above water surface!
                    break;
                }
                if (Perception.isSolidSupport(atWater) && Perception.isPassable(above)
                        && Perception.isPassable(world.getBlockState(new BlockPos(bx, by + 2, bz)))) {
                    score += 16.0; // low 1-block walkable dry bank!
                    break;
                }
                if (atWater.getFluidState().isIn(net.minecraft.registry.tag.FluidTags.WATER)) {
                    score += 3.5; // open swimmable water channel
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestRad = rad;
            }
        }
        return bestRad;
    }

    private BlockPos findNearestDryShore(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        BlockPos best = null;
        double bestDistSq = Double.POSITIVE_INFINITY;
        for (int dx = -12; dx <= 12; dx++) {
            for (int dz = -12; dz <= 12; dz++) {
                // Only dy = 0..1! A player in water CANNOT jump onto a dy = +2 cliff ledge!
                for (int dy = 0; dy <= 1; dy++) {
                    BlockPos cand = feet.add(dx, dy, dz);
                    if (blacklistedTargets.contains(cand)) continue;
                    BlockState st = perception.getObserved(cand);
                    BlockState head = perception.getObserved(cand.up());
                    BlockState below = perception.getObserved(cand.down());
                    if (st != null && head != null && below != null
                            && Perception.isPassable(st) && st.getFluidState().isEmpty()
                            && Perception.isPassable(head) && head.getFluidState().isEmpty()
                            && Perception.isSolidSupport(below)) {
                        double dSq = cand.getSquaredDistance(feet);
                        if (dSq < bestDistSq) {
                            bestDistSq = dSq;
                            best = cand;
                        }
                    }
                }
            }
        }
        return best;
    }

    private BlockPos findSafeCanopyExit(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        for (int r = 1; r <= 5; r++) {
            for (int dx = -r; dx <= r; dx++) {
                for (int dz = -r; dz <= r; dz++) {
                    if (Math.abs(dx) != r && Math.abs(dz) != r) continue;
                    BlockPos edge = feet.add(dx, 0, dz);
                    if (!Perception.isPassable(world.getBlockState(edge))
                            || !Perception.isPassable(world.getBlockState(edge.up()))) continue;
                    // Check for witnessed dry landing within 5 blocks or water within 10 blocks!
                    for (int dy = 1; dy <= 10; dy++) {
                        BlockState st = world.getBlockState(edge.down(dy));
                        if (st.getFluidState().isIn(net.minecraft.registry.tag.FluidTags.WATER)) return edge;
                        if (Perception.isSolidSupport(st)) {
                            if (dy <= 5 && !(st.getBlock() instanceof LeavesBlock)) return edge;
                            break;
                        }
                    }
                }
            }
        }
        return null;
    }

    private boolean ensureToolInHotbar(ClientPlayerEntity player, java.util.function.Predicate<ItemStack> pred) {
        for (int i = 0; i < 9; i++) {
            if (pred.test(player.getInventory().getStack(i))) return true;
        }
        // Check backpack slots 9..35
        for (int i = 9; i < 36; i++) {
            if (pred.test(player.getInventory().getStack(i))) {
                gui.startHotbarSwap(pred);
                return false;
            }
        }
        return false;
    }

    private BlockPos findNearbyWorkstation(ClientPlayerEntity player, ClientWorld world, Block block, double radius) {
        if (world == null) return null;
        Set<BlockPos> set = block == Blocks.CRAFTING_TABLE ? perception.observedTables() : perception.observedFurnaces();
        BlockPos best = null;
        double bestSq = radius * radius;
        BlockPos feet = player.getBlockPos();
        for (BlockPos pos : set) {
            if (!world.getBlockState(pos).isOf(block)) continue;
            double dSq = pos.getSquaredDistance(feet);
            if (dSq < bestSq) {
                bestSq = dSq;
                best = pos;
            }
        }
        return best;
    }

    /**
     * Productive opportunistic work while a furnace is actively cooking nearby:
     * mines nearby coal/iron ore, chops nearby logs if low on wood, or widens nearby stone within 10m of the furnace.
     * Returns true if productive work was executed this tick; false to fall back to waiting by the furnace.
     */
    private boolean doProductiveSmeltChore(ClientPlayerEntity player, ClientWorld world,
                                           BlockPos furnace, int currentTick, int remTicks) {
        // Validate existing chore target (must stay close to furnace and still be a valid mineable block)
        if (smeltChoreTarget != null) {
            BlockState st = world.getBlockState(smeltChoreTarget);
            if (st.isAir() || !st.getFluidState().isEmpty()
                    || smeltChoreTarget.equals(furnace)
                    || smeltChoreTarget.equals(furnace.down())
                    || smeltChoreTarget.equals(placedTablePos)
                    || smeltChoreTarget.getSquaredDistance(furnace) > 10.5 * 10.5
                    || blacklistedTargets.contains(smeltChoreTarget)) {
                smeltChoreTarget = null;
                smeltChoreNoProgressTicks = 0;
                route.clear();
            }
        }

        if (smeltChoreTarget == null) {
            smeltChoreTarget = pickProductiveSmeltChoreTarget(player, world, furnace);
            smeltChoreNoProgressTicks = 0;
            route.clear();
        }
        if (smeltChoreTarget == null) return false;

        int remSec = Math.max(0, remTicks / 20);
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(smeltChoreTarget)) <= Motor.REACH_SQ) {
            boolean broken = motor.mineBlock(smeltChoreTarget, true, true);
            statusText = "mining nearby while smelting (" + remSec + "s)";
            if (broken) {
                rockBrokenCount++;
                perception.markOreRetired(smeltChoreTarget);
                blacklistedTargets.add(smeltChoreTarget);
                smeltChoreTarget = null;
                smeltChoreNoProgressTicks = 0;
            } else if (motor.breakingProgress() > 0.01f) {
                smeltChoreNoProgressTicks = 0;
            } else if (++smeltChoreNoProgressTicks > 40) {
                blacklistedTargets.add(smeltChoreTarget);
                smeltChoreTarget = null;
                smeltChoreNoProgressTicks = 0;
            }
            return true;
        }

        Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.interactReach(smeltChoreTarget, 3.2), opts, currentTick);
        statusText = "gathering nearby while smelting (" + remSec + "s)";
        if (st == RouteExecutor.Status.STUCK) {
            blacklistedTargets.add(smeltChoreTarget);
            smeltChoreTarget = null;
            route.clear();
        }
        return true;
    }

    private BlockPos pickProductiveSmeltChoreTarget(ClientPlayerEntity player, ClientWorld world, BlockPos furnace) {
        BlockPos feet = player.getBlockPos();
        BlockPos underFeet = feet.down();
        int pickTier = bestPickaxeTier(player);

        // 1. Nearby visible/revealed iron ore (if stone+ pickaxe) or coal ore (if wooden+ pickaxe) within 9.5m of furnace
        if (pickTier >= 2) {
            for (BlockPos pos : perception.nearestOreTargets(Perception.OreKind.IRON, furnace, 4, blacklistedTargets)) {
                if (pos.getSquaredDistance(furnace) <= 9.5 * 9.5 && !perception.isNearKnownLava(pos.getX(), pos.getY(), pos.getZ())) {
                    return pos;
                }
            }
        }
        if (pickTier >= 1 && GuiHands.countItem(player, Items.COAL) < 16) {
            for (BlockPos pos : perception.nearestOreTargets(Perception.OreKind.COAL, furnace, 4, blacklistedTargets)) {
                if (pos.getSquaredDistance(furnace) <= 9.5 * 9.5 && !perception.isNearKnownLava(pos.getX(), pos.getY(), pos.getZ())) {
                    return pos;
                }
            }
        }
        // 2. Nearby visible logs if carrying fewer than 6 logs
        if (GuiHands.countLogs(player) < 6) {
            BlockPos log = perception.nearestObserved(perception.observedLogs(), furnace, 9.5, blacklistedTargets);
            if (log != null && Math.abs(log.getY() - feet.getY()) <= 3) {
                return log;
            }
        }
        // 3. Nearby exposed stone block (if pickaxe carried & low-to-moderate cobblestone) — never under feet or furnace!
        if (pickTier >= 1 && GuiHands.countStone(player) < 64) {
            BlockPos bestStone = null;
            double bestDistSq = 7.5 * 7.5;
            for (BlockPos pos : perception.observedStone()) {
                if (blacklistedTargets.contains(pos) || pos.equals(underFeet) || pos.equals(furnace) || pos.equals(furnace.down())) continue;
                if (pos.getY() < feet.getY() || pos.getY() > feet.getY() + 2) continue;
                double dFurn = pos.getSquaredDistance(furnace);
                if (dFurn > bestDistSq) continue;
                if (!isStoneBlock(world.getBlockState(pos))) continue;
                if (perception.isNearKnownLava(pos.getX(), pos.getY(), pos.getZ())) continue;
                if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos)) <= Motor.REACH_SQ && motor.findAimPoint(pos) == null) continue;
                bestDistSq = dFurn;
                bestStone = pos;
            }
            if (bestStone != null) return bestStone;
        }
        return null;
    }

    private BlockPos findPlacementSpotNearPlayer(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        // Pass 1: air/replaceable cell on solid support (dy 0, -1, 1) that doesn't intersect player hitbox
        int[] dyOrder = {0, -1, 1};
        for (int r = 1; r <= 2; r++) {
            for (int dx = -r; dx <= r; dx++) {
                for (int dz = -r; dz <= r; dz++) {
                    if (dx == 0 && dz == 0) continue;
                    for (int dy : dyOrder) {
                        BlockPos cand = feet.add(dx, dy, dz);
                        BlockState st = world.getBlockState(cand);
                        if (!st.isAir() && !st.isReplaceable()) continue;
                        if (!st.getFluidState().isEmpty()) continue;
                        if (!Perception.isSolidSupport(world.getBlockState(cand.down()))) continue;
                        if (motor.findPlacementHit(cand) != null) return cand;
                    }
                }
            }
        }
        // Pass 2: tight tunnel fallback — crafting tables & furnaces can attach to any adjacent solid face!
        for (int r = 1; r <= 2; r++) {
            for (int dx = -r; dx <= r; dx++) {
                for (int dz = -r; dz <= r; dz++) {
                    if (dx == 0 && dz == 0) continue;
                    for (int dy = 0; dy <= 1; dy++) {
                        BlockPos cand = feet.add(dx, dy, dz);
                        BlockState st = world.getBlockState(cand);
                        if (!st.isAir() && !st.isReplaceable()) continue;
                        if (!st.getFluidState().isEmpty()) continue;
                        if (motor.findPlacementHit(cand) != null) return cand;
                    }
                }
            }
        }
        return null;
    }

    /** When in a tight 1x2 tunnel with no free placement cell, carve a 1-block wall alcove for our workstation! */
    private boolean clearAlcoveForWorkstation(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
        for (int dy = 0; dy <= 1; dy++) {
            for (int[] d : dirs) {
                BlockPos wall = feet.add(d[0], dy, d[1]);
                BlockState st = world.getBlockState(wall);
                if (st.isAir() || !st.getFluidState().isEmpty()) continue;
                if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st)) continue;
                if (st.isOf(Blocks.CRAFTING_TABLE) || st.isOf(Blocks.FURNACE)) continue;
                if (perception.isNearKnownLava(wall.getX(), wall.getY(), wall.getZ())) continue;
                if (perception.isNearKnownFluidAboveOrSide(wall.getX(), wall.getY(), wall.getZ())) continue;
                motor.mineBlock(wall, true, true);
                return true;
            }
        }
        return false;
    }

    private static boolean isHighValueDrop(Item it) {
        return it == Items.DIAMOND || it == Items.RAW_IRON || it == Items.IRON_INGOT
            || it == Items.CRAFTING_TABLE || it == Items.FURNACE;
    }

    private ItemEntity findNearbyValuableDrop(ClientPlayerEntity player, double radius) {
        double rSq = radius * radius;
        ItemEntity best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        boolean wantStone = (active != null && active.kind() == TaskKind.MINE_STONE) || GuiHands.countStone(player) < 14;
        for (ItemEntity item : perception.visibleDrops()) {
            if (ignoredDrops.contains(item.getId())) continue;
            double dSq = item.squaredDistanceTo(player);
            if (dSq > rSq) continue;
            // Don't chase drops perched high up in tree canopies or deep pits!
            double dy = item.getY() - player.getY();
            if (dy > 1.5 || dy < -2.4) continue;
            Item it = item.getStack().getItem();
            boolean high = isHighValueDrop(it);
            boolean valuable = high || it == Items.COAL
                || item.getStack().isIn(ItemTags.LOGS)
                || Motor.foodScore(item.getStack(), true) > 0
                || (wantStone && (it == Items.COBBLESTONE || it == Items.COBBLED_DEEPSLATE));
            if (!valuable) continue;
            double score = dSq - (high ? 100.0 : 0.0);
            if (score < bestScore) {
                bestScore = score;
                best = item;
            }
        }
        return best;
    }

    private void finishActive(String outcome, String detail, int tick) {
        if (active != null) {
            recentReceipts.addLast(new TaskReceipt(active.id(), active.kind().name().toLowerCase(),
                active.target(), outcome, detail, tick));
            while (recentReceipts.size() > 8) recentReceipts.removeFirst();
        }
        active = null;
        activeTargetBlock = null;
        route.clear();
    }

    static int bestPickaxeTier(ClientPlayerEntity player) {
        int best = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            best = Math.max(best, pickaxeTier(inv.getStack(i).getItem()));
        }
        return best;
    }

    static boolean hasAnyPickaxe(ClientPlayerEntity player) { return bestPickaxeTier(player) > 0; }

    static int pickaxeTier(Item item) {
        if (item == Items.NETHERITE_PICKAXE) return 5;
        if (item == Items.DIAMOND_PICKAXE) return 4;
        if (item == Items.IRON_PICKAXE) return 3;
        if (item == Items.STONE_PICKAXE) return 2;
        if (item == Items.WOODEN_PICKAXE || item == Items.GOLDEN_PICKAXE) return 1;
        return 0;
    }

    static int scaffoldCount(ClientPlayerEntity player) {
        return GuiHands.countItem(player, Items.COBBLESTONE)
            + GuiHands.countItem(player, Items.COBBLED_DEEPSLATE)
            + GuiHands.countItem(player, Items.DIRT)
            + GuiHands.countItem(player, Items.NETHERRACK);
    }

    private static boolean isStoneBlock(BlockState st) {
        Block b = st.getBlock();
        return b == Blocks.STONE || b == Blocks.COBBLESTONE || b == Blocks.DEEPSLATE || b == Blocks.COBBLED_DEEPSLATE;
    }

    private static boolean matchesOreBlock(BlockState st, Perception.OreKind kind) {
        Block b = st.getBlock();
        return switch (kind) {
            case COAL -> b == Blocks.COAL_ORE || b == Blocks.DEEPSLATE_COAL_ORE;
            case IRON -> b == Blocks.IRON_ORE || b == Blocks.DEEPSLATE_IRON_ORE;
            case DIAMOND -> b == Blocks.DIAMOND_ORE || b == Blocks.DEEPSLATE_DIAMOND_ORE;
        };
    }

    private static Perception.OreKind parseOreKind(String name) {
        if (name == null) return Perception.OreKind.IRON;
        return switch (name.toLowerCase()) {
            case "coal", "coal_ore" -> Perception.OreKind.COAL;
            case "diamond", "diamond_ore" -> Perception.OreKind.DIAMOND;
            default -> Perception.OreKind.IRON;
        };
    }

    static GuiHands.RecipeId parseRecipe(String name) {
        if (name == null) return null;
        String clean = name.toLowerCase().replace("minecraft:", "").trim();
        for (GuiHands.RecipeId r : GuiHands.RecipeId.values()) {
            if (r.name().equalsIgnoreCase(clean)) return r;
        }
        if (clean.endsWith("_planks")) return GuiHands.RecipeId.PLANKS;
        if (clean.endsWith("_boat")) return GuiHands.RecipeId.BOAT;
        return null;
    }

    private static boolean needsPlanksFor(GuiHands.RecipeId r, ClientPlayerEntity p) {
        if (r == GuiHands.RecipeId.PLANKS) return false;
        int need = 0;
        for (String row : r.rows) for (char c : row.toCharArray()) if (c == 'p') need++;
        return need > 0 && GuiHands.countPlanks(p) < need;
    }

    private static boolean needsSticksFor(GuiHands.RecipeId r, ClientPlayerEntity p) {
        if (r == GuiHands.RecipeId.STICK || r == GuiHands.RecipeId.PLANKS) return false;
        int need = 0;
        for (String row : r.rows) for (char c : row.toCharArray()) if (c == 's') need++;
        return need > 0 && GuiHands.countItem(p, Items.STICK) < need;
    }

    private static Item findBestRawMeat(ClientPlayerEntity p) {
        Item[] raw = {Items.BEEF, Items.PORKCHOP, Items.MUTTON, Items.CHICKEN, Items.RABBIT};
        for (Item item : raw) if (GuiHands.countItem(p, item) > 0) return item;
        return null;
    }

    private static Item cookedOf(Item raw) {
        if (raw == Items.BEEF) return Items.COOKED_BEEF;
        if (raw == Items.PORKCHOP) return Items.COOKED_PORKCHOP;
        if (raw == Items.MUTTON) return Items.COOKED_MUTTON;
        if (raw == Items.CHICKEN) return Items.COOKED_CHICKEN;
        if (raw == Items.RABBIT) return Items.COOKED_RABBIT;
        return null;
    }
}
