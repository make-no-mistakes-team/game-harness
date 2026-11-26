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
        DESCEND_DROP,
        EXPLORE_CAVE,
        CAST_PORTAL,
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
    private final SafeDescent descent;
    private final CaveExplorer caves;
    private final PortalCaster portal;
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
    private Item smeltInputItem;
    private Item smeltOutputItem;
    private BlockPos smeltChoreTarget;
    private int smeltChoreNoProgressTicks;
    private boolean recoveringWorkstation;
    private BlockPos workstationToRecover;
    private int workstationRecoverTicks;
    private int workstationOpenStuckTicks;
    private int branchDirIndex;
    private BlockPos branchWaypoint;
    private int branchLegSegments;
    private int descentLateralTicks;
    private int exitCaveTicks;
    private double exploreHeadingRad = 0.7;
    private int exploreFlipCount;
    private Vec3d exploreLastPos;
    private int exploreStuckTicks;
    private int dropChaseEntityId = -1;
    private int dropChaseTicks;
    private int rockBrokenCount;

    TaskRunner(MinecraftClient client, Motor motor, Perception perception,
               Pathfinder pathfinder, RouteExecutor route, GuiHands gui,
               SurvivalReflexes reflexes, SafeDescent descent, CaveExplorer caves, PortalCaster portal, String goal) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
        this.pathfinder = pathfinder;
        this.route = route;
        this.gui = gui;
        this.reflexes = reflexes;
        this.descent = descent;
        this.caves = caves;
        this.portal = portal;
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
        smeltInputItem = null;
        smeltOutputItem = null;
        recoveringWorkstation = false;
        workstationToRecover = null;
        workstationRecoverTicks = 0;
        workstationOpenStuckTicks = 0;
        branchWaypoint = null;
        branchLegSegments = 0;
        descentLateralTicks = 0;
        exitCaveTicks = 0;
        route.clear();
        gui.abort();
        blacklistedTargets.clear();
        ignoredDrops.clear();
        dropChaseCounts.clear();
        dropChaseEntityId = -1;
        dropChaseTicks = 0;
        noMineProgressTicks = 0;
        if (descent != null) descent.resetForLife();
        if (caves != null) caves.resetForLife();
        if (portal != null) portal.resetForLife();
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
    void applyModelPlan(List<Task> tasks, boolean replaceQueue, Boolean safeMode, SafeDescent.Method descentMethod) {
        if (safeMode != null) this.safeExcavationMode = safeMode;
        if (descent != null && descentMethod != null) {
            descent.setPreferredMethod(descentMethod);
        }
        if (tasks == null || tasks.isEmpty()) return;
        if (replaceQueue) {
            queue.clear();
            // Interrupt active task cleanly when strategist explicitly replaces the queue
            // (never abort mid-GUI click, loaded furnace, or mid-air/mid-descent maneuver!)
            boolean descentBusy = descent != null && descent.isActivelyDescending();
            boolean portalBusy = portal != null && portal.isActive();
            if (active != null && !gui.isBusy() && !smeltLoaded && !descentBusy && !portalBusy) {
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
        if (active == null || (active.kind() != TaskKind.CRAFT && active.kind() != TaskKind.SMELT
                && active.kind() != TaskKind.DESCEND_DROP && active.kind() != TaskKind.CAST_PORTAL)) {
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
            workstationRecoverTicks++;
            BlockState st = world.getBlockState(workstationToRecover);
            if (st.isAir() || (!st.isOf(Blocks.CRAFTING_TABLE) && !st.isOf(Blocks.FURNACE)) || workstationRecoverTicks > 140) {
                recoveringWorkstation = false;
                workstationToRecover = null;
                workstationRecoverTicks = 0;
                route.clear();
            } else if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(workstationToRecover)) <= Motor.REACH_SQ
                    && motor.findAimPoint(workstationToRecover) != null) {
                motor.mineBlock(workstationToRecover, true);
                statusText = "picking up workstation";
                return;
            } else {
                boolean closeOccluded = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(workstationToRecover)) <= 3.8 * 3.8;
                Pathfinder.Goal recGoal = closeOccluded
                    ? Pathfinder.Goal.near(workstationToRecover, 1.45)
                    : Pathfinder.Goal.interactReach(workstationToRecover, 3.4);
                RouteExecutor.Status recSt = navigateToward(player, recGoal,
                    Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true), currentTick);
                if (recSt == RouteExecutor.Status.STUCK || recSt == RouteExecutor.Status.COMPLETE) {
                    BlockPos blocker = findSafeOccludingBlock(player, world, workstationToRecover);
                    if (blocker != null) {
                        motor.mineBlock(blocker, true, false);
                        statusText = "clearing view to workstation";
                        return;
                    }
                    if (recSt == RouteExecutor.Status.STUCK) {
                        recoveringWorkstation = false;
                        workstationToRecover = null;
                        workstationRecoverTicks = 0;
                        route.clear();
                    }
                }
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
            smeltInputItem = null;
            smeltOutputItem = null;
            workstationOpenStuckTicks = 0;
            branchWaypoint = null;
            branchLegSegments = 0;
            descentLateralTicks = 0;
            route.clear();
        }

        if (active == null) {
            statusText = "goal complete";
            return;
        }

        int maxTicks = (active.kind() == TaskKind.MINE_ORE && !perception.isDiagnosticRevealOres())
            ? 9000
            : ((active.kind() == TaskKind.MINE_ORE || active.kind() == TaskKind.DIG_DOWN
                || active.kind() == TaskKind.DESCEND_DROP || active.kind() == TaskKind.EXPLORE_CAVE
                || active.kind() == TaskKind.CAST_PORTAL) ? 6000
                : (active.kind() == TaskKind.MINE_STONE ? 3600 : 2400));
        if (activeTicks > maxTicks) {
            if (descent != null && descent.isActivelyDescending()) descent.clearActive();
            if (portal != null && portal.isActive()) portal.clearActive();
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
            case DESCEND_DROP -> tickDescendDrop(player, world, currentTick);
            case EXPLORE_CAVE -> tickExploreCave(player, world, currentTick);
            case CAST_PORTAL -> tickCastPortal(player, world, currentTick);
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

        // If standing on top of a tree canopy (e.g. dark oak forest roof spawn), drop safely to the forest floor first!
        BlockPos feet = player.getBlockPos();
        if (world.getBlockState(feet.down()).getBlock() instanceof LeavesBlock) {
            BlockPos immediateLog = findImmediateReachableLog(player, world);
            if (immediateLog != null) {
                motor.mineBlock(immediateLog, true, false);
                statusText = "chopping canopy log";
                return;
            }
            if (descendFromTreeCanopy(player, world)) {
                statusText = "descending from tree canopy";
                return;
            }
        }
        if (activeTargetBlock == null || !world.getBlockState(activeTargetBlock).isIn(BlockTags.LOGS)) {
            activeTargetBlock = findBestLogTarget(player, world);
            route.clear();
        }

        boolean underground = world.getLightLevel(net.minecraft.world.LightType.SKY, feet) <= 10
            || hasRockRoofAbove(world, feet);
        if (activeTargetBlock == null) {
            // If underground inside a cave/tunnel/pocket, climb/staircase back up to the surface instead of walking into walls!
            if (underground) {
                Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
                int surfaceY = Math.max(feet.getY() + 8, 66);
                navigateToward(player, Pathfinder.Goal.climbToY(surfaceY), opts, currentTick);
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

        // Never float or submerge in water to chop riverbank wood when dry land is nearby — climb onto dry land first!
        if (player.isSubmergedInWater()
                || (player.isTouchingWater() && (!player.isOnGround() || findNearestDryShore(player, world) != null))) {
            route.clear();
            exploreForResources(player, world, currentTick, "getting onto dry land before chopping wood");
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

        // Navigate toward log (use mining pathfinder if underground OR inside a pit where surface route can't climb out!)
        Pathfinder.Options opts = underground
            ? Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true)
            : Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f);
        RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.interactReach(activeTargetBlock, 3.6), opts, currentTick);
        statusText = "approaching tree";
        if (st == RouteExecutor.Status.STUCK) {
            if (!underground) {
                // Might be standing in a sunlit 2-deep pit: try climbing out with mining-capable A* before giving up on the tree!
                RouteExecutor.Status esc = navigateToward(player, Pathfinder.Goal.interactReach(activeTargetBlock, 3.6),
                    Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true), currentTick);
                if (esc != RouteExecutor.Status.STUCK) {
                    statusText = "climbing out toward tree";
                    return;
                }
            }
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
            outerWater:
            for (int wx = -1; wx <= 1; wx++) {
                for (int wz = -1; wz <= 1; wz++) {
                    for (int d = 0; d <= 3; d++) {
                        BlockState below = perception.getObserved(pos.getX() + wx, pos.getY() - d, pos.getZ() + wz);
                        if (below != null && !below.getFluidState().isEmpty()) {
                            waterPenalty = 26.0;
                            break outerWater;
                        }
                    }
                }
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
            if (player.isSubmergedInWater() || (player.isTouchingWater() && !player.isOnGround())) {
                route.clear();
                exploreForResources(player, world, currentTick, "getting onto dry land before mining stone");
                return;
            }
            if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ
                    && motor.findAimPoint(activeTargetBlock) != null) {
                BlockPos headroomFirst = findHeadroomBlockerForLowTarget(player, world, activeTargetBlock);
                if (headroomFirst != null) {
                    motor.mineBlock(headroomFirst, true, false);
                    statusText = "clearing headroom before mining stone";
                    return;
                }
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
                // Within reach but occluded — clear upper front headroom first if digging low, then mine!
                if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ) {
                    BlockPos headroomFirst = findHeadroomBlockerForLowTarget(player, world, activeTargetBlock);
                    if (headroomFirst != null) {
                        motor.mineBlock(headroomFirst, true, false);
                        statusText = "clearing headroom before mining stone";
                        return;
                    }
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

        // 2. No exposed stone spotted yet — avoid burning a wooden pickaxe through 30+ layers of high Badlands terracotta!
        BlockState groundUnder = world.getBlockState(player.getBlockPos().down());
        boolean onHighTerracotta = bestPickaxeTier(player) == 1
            && (groundUnder.isIn(BlockTags.TERRACOTTA) || player.getBlockY() >= 84)
            && activeTicks < 520;
        if (onHighTerracotta) {
            route.clear();
            exploreForResources(player, world, currentTick, "scouting downhill for exposed stone");
            return;
        }
        // Ensure we're on DRY land before digging a staircase down!
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
        // When mining diamonds, keep a stone pickaxe in hotbar too (if carried in backpack) to preserve iron pickaxe durability on deepslate!
        if (oreKind == Perception.OreKind.DIAMOND && GuiHands.countItem(player, Items.STONE_PICKAXE) > 0
                && motor.findHotbarItem(Items.STONE_PICKAXE) < 0) {
            if (!ensureToolInHotbar(player, st -> st.isOf(Items.STONE_PICKAXE))) {
                statusText = "moving stone pickaxe to hotbar";
                return;
            }
        }
        // If unassisted diamond branch-mining burns through our spare stone pickaxe and iron pickaxe is getting low,
        // pause cleanly to craft a fresh stone pickaxe from carried cobblestone + wood instead of breaking our iron pickaxe!
        if (oreKind == Perception.OreKind.DIAMOND && activeTargetBlock == null
                && GuiHands.countItem(player, Items.STONE_PICKAXE) == 0
                && GuiHands.countStone(player) >= 3
                && (GuiHands.countItem(player, Items.STICK) >= 2 || GuiHands.countPlanks(player) >= 2 || GuiHands.countLogs(player) >= 1)
                && remainingIronPickDurability(player) < 90) {
            finishActive("partial", "crafting spare stone pickaxe to preserve iron pickaxe", currentTick);
            return;
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
            // Only reset the active route when we actually acquired a concrete ore target!
            // Clearing route while activeTargetBlock == null would wipe descent/branch-mining every tick!
            if (activeTargetBlock != null) {
                branchWaypoint = null;
                route.clear();
            }
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
            int targetY = switch (oreKind) {
                case COAL -> 48;
                case IRON -> 16;
                case DIAMOND -> -54;
            };
            // In honest unassisted mode, scout surface for cave mouths & ravines, explore deep caves for exposed ore,
            // exit shallow dead-end caves to seek bigger caves/ravines, and fall back to deep branch mining when appropriate!
            if (!perception.isDiagnosticRevealOres() && caves != null) {
                tickCaveSearch(player, world, oreKind, targetY, currentTick);
                return;
            }
            tickDescentAndBranchMine(player, world, active.target(), targetY, currentTick);
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
            BlockPos headroomFirst = findHeadroomBlockerForLowTarget(player, world, immediateOre);
            if (headroomFirst != null) {
                motor.mineBlock(headroomFirst, true, false);
                statusText = "clearing headroom for " + active.target() + " ore";
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
        // Clear upper-front headroom first when digging low ahead so we always create a walkable 2-high opening!
        if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(activeTargetBlock)) <= Motor.REACH_SQ) {
            if (perception.isNearKnownLava(activeTargetBlock.getX(), activeTargetBlock.getY(), activeTargetBlock.getZ())) {
                blacklistedTargets.add(activeTargetBlock);
                activeTargetBlock = null;
                route.clear();
                return;
            }
            BlockPos headroomFirst = findHeadroomBlockerForLowTarget(player, world, activeTargetBlock);
            if (headroomFirst != null) {
                motor.mineBlock(headroomFirst, true, false);
                statusText = "clearing headroom for " + active.target() + " ore";
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

    /**
     * When directly mining a block at or below feet level ahead of us, ensure the upper-front face block
     * (headroom) is cleared first so we never dig an unwalkable 1-block mousehole we cannot step forward into!
     */
    private BlockPos findHeadroomBlockerForLowTarget(ClientPlayerEntity player, ClientWorld world, BlockPos target) {
        BlockPos feet = player.getBlockPos();
        if (target.getY() > feet.getY()) return null;
        int dx = target.getX() - feet.getX();
        int dz = target.getZ() - feet.getZ();
        if (dx == 0 && dz == 0) return null;

        int stepX = feet.getX() + (Math.abs(dx) >= Math.abs(dz) ? Integer.signum(dx) : 0);
        int stepZ = feet.getZ() + (Math.abs(dz) > Math.abs(dx) ? Integer.signum(dz) : 0);
        BlockPos[] candidates = {
            new BlockPos(stepX, feet.getY() + 1, stepZ),
            new BlockPos(target.getX(), feet.getY() + 1, target.getZ())
        };
        for (BlockPos cand : candidates) {
            if (cand.equals(target)) continue;
            BlockState st = world.getBlockState(cand);
            if (Perception.isPassable(st) || !st.getFluidState().isEmpty()) continue;
            if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st)) continue;
            if (st.isOf(Blocks.CRAFTING_TABLE) || st.isOf(Blocks.FURNACE) || st.isOf(Blocks.OBSIDIAN)) continue;
            if (perception.isNearKnownLava(cand.getX(), cand.getY(), cand.getZ())) continue;
            if (perception.isNearKnownFluidAboveOrSide(cand.getX(), cand.getY(), cand.getZ())) continue;
            if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(cand)) > Motor.REACH_SQ) continue;
            if (motor.findAimPoint(cand) != null) return cand;
        }
        return null;
    }

    private BlockPos findBestStoneTarget(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        // 1. Prefer directly aimable stone within reach, strongly favoring face-level (dy=+1) BEFORE feet/low blocks
        //    so we always carve a clean walkable 2-high gallery instead of a 1-high ankle hole!
        BlockPos underFeet = feet.down();
        BlockPos bestImmediate = null;
        double bestImmScore = Double.POSITIVE_INFINITY;
        for (BlockPos pos : perception.observedStone()) {
            if (blacklistedTargets.contains(pos) || pos.equals(underFeet)) continue;
            double dSq = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos));
            if (dSq > Motor.REACH_SQ) continue;
            if (!isStoneBlock(world.getBlockState(pos))) continue;
            if (perception.isNearKnownLava(pos.getX(), pos.getY(), pos.getZ())) continue;
            if (motor.findAimPoint(pos) == null) continue;
            int dy = pos.getY() - feet.getY();
            boolean upperSolid = !Perception.isPassable(world.getBlockState(new BlockPos(pos.getX(), feet.getY() + 1, pos.getZ())));
            if (dy < 0 && upperSolid) continue; // never dig under a solid face block!
            double heightPenalty = dy == 1 ? 0.0 : (dy == 0 ? (upperSolid ? 3.5 : 1.0) : (dy < 0 ? 4.5 : 1.8));
            double score = Math.sqrt(dSq) + heightPenalty;
            if (score < bestImmScore) {
                bestImmScore = score;
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

            // Walk into clear line-of-sight & reach of the crafting table and open it!
            if (!(client.currentScreen instanceof CraftingScreen)) {
                approachAndInteractWorkstation(player, world, table, currentTick, "walking to crafting table", "opening crafting table");
                return;
            }
            workstationOpenStuckTicks = 0;
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
        boolean meatTarget = isMeatSmeltTarget(active.target());
        if (smeltInputItem == null || (!smeltLoaded && GuiHands.countItem(player, smeltInputItem) <= 0)) {
            smeltInputItem = resolveSmeltInput(active.target(), player);
            smeltOutputItem = smeltInputItem == Items.RAW_IRON ? Items.IRON_INGOT : cookedOf(smeltInputItem);
        }
        Item inputItem = smeltInputItem;
        Item outputItem = smeltOutputItem;
        int targetOut = Math.max(1, active.count());
        int haveOut = meatTarget
            ? countCookedMeat(player)
            : (outputItem == null ? 0 : GuiHands.countItem(player, outputItem));

        if (haveOut >= targetOut && !smeltLoaded) {
            if (placedFurnacePos != null && world.getBlockState(placedFurnacePos).isOf(Blocks.FURNACE)) {
                workstationToRecover = placedFurnacePos;
                recoveringWorkstation = true;
                placedFurnacePos = null;
            }
            finishActive("completed", "smelted " + (outputItem != null ? outputItem.getName().getString() : active.target()), currentTick);
            return;
        }

        if (gui.state() == GuiHands.State.DONE) {
            gui.abort();
            if (smeltCollecting) {
                smeltCollecting = false;
                smeltLoaded = false;
                int nowOut = meatTarget
                    ? countCookedMeat(player)
                    : (outputItem == null ? 0 : GuiHands.countItem(player, outputItem));
                int remIn = meatTarget
                    ? countRawMeat(player)
                    : (inputItem == null ? 0 : GuiHands.countItem(player, inputItem));
                smeltInputItem = null;
                smeltOutputItem = null;
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

            // Otherwise (<= 7s left, low HP, or no useful chore nearby): walk back into clear sight of the furnace!
            smeltChoreTarget = null;
            if (distToFurnaceSq > 3.2 * 3.2 || motor.findAimPoint(furnace) == null) {
                Pathfinder.Goal retGoal = distToFurnaceSq <= 3.8 * 3.8
                    ? Pathfinder.Goal.near(furnace, 1.45)
                    : Pathfinder.Goal.interactReach(furnace, 3.0);
                navigateToward(player, retGoal,
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

        // Walk into clear line-of-sight & reach of the furnace and open it!
        if (!(client.currentScreen instanceof FurnaceScreen)) {
            approachAndInteractWorkstation(player, world, furnace, currentTick, "walking to furnace", "opening furnace");
            return;
        }
        workstationOpenStuckTicks = 0;

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
                Math.max(1, targetOut - haveOut));
            smeltBatchSize = toSmelt;
            gui.startFurnaceLoad(inputItem, toSmelt);
            statusText = meatTarget ? "cooking food in furnace" : "loading furnace";
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
            if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(berry)) <= Motor.REACH_SQ
                    && motor.findAimPoint(berry) != null) {
                motor.interactBlock(berry);
                statusText = "harvesting sweet berries";
                return;
            }
            navigateToward(player, Pathfinder.Goal.interactReach(berry, 3.2),
                Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f), currentTick);
            statusText = "walking to berry bush";
            return;
        }

        // 2. Hunt nearest visible passive food animal!
        List<AnimalEntity> animals = perception.visibleFoodAnimals();
        if (!animals.isEmpty()) {
            AnimalEntity quarry = animals.get(0);
            motor.selectBestWeapon();
            double hRad = Math.atan2(quarry.getZ() - player.getZ(), quarry.getX() - player.getX());
            boolean needHop = shouldStepUpAlongHeading(player, world, hRad) || player.horizontalCollision || player.isTouchingWater();
            if (player.distanceTo(quarry) <= 3.3) {
                motor.attackEntity(quarry);
                motor.moveToward(quarry.getPos(), false, needHop, false, false);
            } else {
                motor.moveToward(quarry.getPos(), !player.isTouchingWater(), needHop, false, true);
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
            if (descent != null && descent.isActivelyDescending()) descent.clearActive();
            finishActive("completed", "reached y=" + player.getBlockY(), currentTick);
            return;
        }
        // If already executing a SafeDescent maneuver into an encountered giant cavern/drop, let it finish!
        if (descent != null && descent.isActivelyDescending()) {
            SafeDescent.RunStatus ds = descent.tickActiveDescent(player, world, currentTick);
            statusText = descent.statusText();
            if (ds == SafeDescent.RunStatus.COMPLETED || ds == SafeDescent.RunStatus.REFUSED || ds == SafeDescent.RunStatus.FAILED) {
                route.clear();
            }
            return;
        }
        // If we encounter a real observed sharp cavern drop (> 4 blocks) while digging down, evaluate SafeDescent!
        if (descent != null && player.getBlockY() > targetY + 4 && activeTicks > 10) {
            SafeDescent.Overlook ov = descent.lastOverlook();
            if (ov != null && ov.dropDepth() >= 5 && (!ov.floorObserved() || ov.landingY() >= targetY - 12)) {
                SafeDescent.Decision dec = descent.lastDecision();
                if (dec.shouldDescend() || ov.landingLava()) {
                    route.clear();
                    descent.startDescent(player, world, descent.preferredMethod(), targetY, active.pos());
                    statusText = descent.statusText();
                    return;
                }
            }
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

    private void tickDescendDrop(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (descent == null) {
            finishActive("failed", "descent subsystem unavailable", currentTick);
            return;
        }
        if (!descent.isActivelyDescending()) {
            SafeDescent.Method req = SafeDescent.Method.parse(active.target());
            int desiredY = active.pos() != null ? active.pos().getY()
                : (active.count() != 0 ? active.count() : Integer.MIN_VALUE);
            descent.startDescent(player, world, req, desiredY, active.pos());
        }
        SafeDescent.RunStatus ds = descent.tickActiveDescent(player, world, currentTick);
        statusText = descent.statusText().isEmpty() ? "descending cavern drop" : descent.statusText();
        switch (ds) {
            case COMPLETED -> finishActive("completed",
                "descended via " + descent.activeMethodName() + " to y=" + player.getBlockY(), currentTick);
            case REFUSED -> finishActive("refused",
                "refused unsafe drop: " + descent.refusedHazard(), currentTick);
            case FAILED -> finishActive("failed",
                "descent failed at y=" + player.getBlockY(), currentTick);
            default -> {}
        }
    }

    private void tickExploreCave(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        Perception.OreKind oreKind = parseOreKind(active.target());
        int targetY = active.count() != 0 ? active.count() : switch (oreKind) {
            case COAL -> 48;
            case IRON -> 16;
            case DIAMOND -> -54;
        };
        // If we already spotted visible target ore while exploring, finish cleanly so mine_ore grabs it!
        if (!perception.nearestOreTargets(oreKind, player.getBlockPos(), 1, blacklistedTargets).isEmpty()) {
            finishActive("completed", "spotted visible " + active.target() + " ore in cave", currentTick);
            return;
        }
        if (caves == null) {
            tickDescentAndBranchMine(player, world, active.target(), targetY, currentTick);
            return;
        }
        tickCaveSearch(player, world, oreKind, targetY, currentTick);
    }

    /**
     * Human-like cave & ravine search loop (100% perception-honest):
     * 1) Scout surface for shaded cave mouths & deep ravines (preferring ravines and deep openings)
     * 2) Enter caves, opportunistically mine useful nearby exposed coal/iron along the way, and follow deep frontiers
     * 3) Use SafeDescent when encountering deep safe cavern/ravine drops
     * 4) Exit shallow dead-end caves back to surface to find larger/deeper caves or ravines
     * 5) Transition cleanly to cardinal branch-mining once already deep underground or after surface scouting times out
     */
    private void tickCaveSearch(ClientPlayerEntity player, ClientWorld world,
                                Perception.OreKind desiredOre, int targetY, int currentTick) {
        BlockPos feet = player.getBlockPos();
        int skyLight = world.getLightLevel(net.minecraft.world.LightType.SKY, feet);
        boolean insideCave = skyLight <= 8 || feet.getY() <= 52;

        // 0. If currently executing a SafeDescent into a cavern or ravine, let it finish cleanly!
        if (descent != null && descent.isActivelyDescending()) {
            SafeDescent.RunStatus ds = descent.tickActiveDescent(player, world, currentTick);
            statusText = descent.statusText();
            if (ds == SafeDescent.RunStatus.COMPLETED || ds == SafeDescent.RunStatus.REFUSED || ds == SafeDescent.RunStatus.FAILED) {
                route.clear();
            }
            return;
        }

        // 1. Opportunistically mine close visible useful coal or iron inside a cave so shallow caves still pay off!
        if (insideCave && caves.mode() == CaveExplorer.Mode.EXPLORING_CAVE) {
            BlockPos bonusOre = findOpportunisticCaveOre(player, world, desiredOre);
            if (bonusOre != null) {
                if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(bonusOre)) <= Motor.REACH_SQ
                        && motor.findAimPoint(bonusOre) != null) {
                    BlockPos headroomFirst = findHeadroomBlockerForLowTarget(player, world, bonusOre);
                    if (headroomFirst != null) {
                        motor.mineBlock(headroomFirst, true, false);
                        statusText = "clearing headroom for cave ore";
                        return;
                    }
                    boolean broken = motor.mineBlock(bonusOre, true, true);
                    statusText = "mining exposed cave ore";
                    if (broken) {
                        rockBrokenCount++;
                        perception.markOreRetired(bonusOre);
                        blacklistedTargets.add(bonusOre);
                        noMineProgressTicks = 0;
                    } else if (motor.breakingProgress() > 0.01f) {
                        noMineProgressTicks = 0;
                    } else if (++noMineProgressTicks > 45) {
                        blacklistedTargets.add(bonusOre);
                        noMineProgressTicks = 0;
                    }
                    return;
                }
                RouteExecutor.Status bst = navigateToward(player, Pathfinder.Goal.interactReach(bonusOre, 3.3),
                    Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true), currentTick);
                statusText = "approaching exposed cave ore";
                if (bst == RouteExecutor.Status.STUCK) {
                    blacklistedTargets.add(bonusOre);
                    route.clear();
                }
                return;
            }
        }

        switch (caves.mode()) {
            case APPROACHING_ENTRANCE -> {
                CaveExplorer.Entrance ent = caves.activeEntrance();
                if (ent == null || ent.exhausted) {
                    caves.setMode(CaveExplorer.Mode.SURFACE_SCOUT, currentTick);
                    route.clear();
                    return;
                }
                double distSq = feet.getSquaredDistance(ent.pos);
                // Reached the cave mouth or ravine lip? Enter and scan the interior!
                if (insideCave || distSq <= 4.5 * 4.5) {
                    caves.beginExploringCave(feet, currentTick);
                    caves.beginGlance(player.getYaw(), 14);
                    route.clear();
                    statusText = ent.ravineLike ? "inspecting ravine opening" : "entering cave mouth";
                    return;
                }
                // Check SafeDescent if we arrived right at a ravine rim overlooking a deep drop
                if (tryStartCaveSafeDescent(player, world, targetY)) return;

                Pathfinder.Options opts = distSq <= 12.0 * 12.0
                    ? Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true)
                    : Pathfinder.Options.surface(scaffoldCount(player), player.getHealth() > 10f);
                RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.near(ent.pos, 2.8), opts, currentTick);
                statusText = ent.ravineLike
                    ? "heading to ravine (" + (int) Math.round(Math.sqrt(distSq)) + "m)"
                    : "heading to cave entrance (" + (int) Math.round(Math.sqrt(distSq)) + "m)";
                if (st == RouteExecutor.Status.STUCK) {
                    caves.markActiveEntranceExhausted(currentTick);
                    caves.setMode(CaveExplorer.Mode.SURFACE_SCOUT, currentTick);
                    route.clear();
                }
            }

            case EXPLORING_CAVE -> {
                // Brief natural pause-glance at cave bends to map dark branches & ores on walls
                if (caves.tickGlance()) {
                    float phase = (14 - caves.glanceTicks()) / 14.0f;
                    float sweep = (float) Math.sin(phase * Math.PI * 2.0) * 46.0f;
                    motor.lookAtAngles(caves.glanceBaseYaw() + sweep, 14.0f, Motor.LookMode.SCAN);
                    statusText = "scanning cave passages (y=" + feet.getY() + ")";
                    return;
                }

                // If overlooking a safe deep cavern/ravine drop, use SafeDescent (waterfall / boat / cliff stair / edge blocks)!
                if (tryStartCaveSafeDescent(player, world, targetY)) return;

                BlockPos frontier = caves.activeFrontier();
                if (frontier != null && (caves.isVisitedOrUnreachable(frontier) || feet.getSquaredDistance(frontier) <= 2.6 * 2.6)) {
                    caves.setActiveFrontier(null);
                    frontier = null;
                    route.clear();
                    caves.beginGlance(player.getYaw(), 10);
                }
                if (frontier == null) {
                    frontier = caves.selectBestCaveFrontier(perception, feet, player.getYaw(), targetY);
                    if (frontier != null) {
                        caves.setActiveFrontier(frontier);
                        route.clear();
                    }
                }

                CaveExplorer.CaveVerdict verdict = caves.evaluateCurrentCave(
                    feet.getY(), targetY, frontier != null, false, currentTick);
                if (verdict == CaveExplorer.CaveVerdict.EXIT_SHALLOW_CAVE) {
                    caves.markActiveEntranceExhausted(currentTick);
                    if (caves.exhaustedCaveCount() >= 3) {
                        caves.setMode(CaveExplorer.Mode.DEEP_BRANCH_MINE, currentTick);
                        statusText = "3 shallow caves checked; digging staircase";
                    } else {
                        exitCaveTicks = 0;
                        caves.setMode(CaveExplorer.Mode.EXITING_SHALLOW_CAVE, currentTick);
                        statusText = "leaving shallow dead-end cave";
                    }
                    route.clear();
                    return;
                }
                if (verdict == CaveExplorer.CaveVerdict.TRANSITION_DEEP_MINE) {
                    caves.setMode(CaveExplorer.Mode.DEEP_BRANCH_MINE, currentTick);
                    route.clear();
                    statusText = "deep cave ended; starting branch mine";
                    return;
                }

                if (frontier == null) {
                    // Brief look around to discover any newly visible passage before re-evaluating
                    caves.beginGlance(player.getYaw() + 90f, 12);
                    statusText = "checking cave branches";
                    return;
                }

                int fTicks = caves.incrementFrontierTicks();
                Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
                RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.near(frontier, 2.2), opts, currentTick);
                statusText = "exploring cave toward y=" + frontier.getY() + " (" + desiredOre.name().toLowerCase() + ")";
                if (st == RouteExecutor.Status.STUCK || fTicks > 220) {
                    caves.markFrontierUnreachable(frontier);
                    route.clear();
                } else if (st == RouteExecutor.Status.COMPLETE) {
                    caves.setActiveFrontier(null);
                    caves.beginGlance(player.getYaw(), 10);
                    route.clear();
                }
            }

            case EXITING_SHALLOW_CAVE -> {
                exitCaveTicks++;
                boolean onSurface = (skyLight >= 11 && feet.getY() >= 56)
                    || (feet.getY() >= 62 && !hasRockRoofAbove(world, feet));
                if (onSurface) {
                    exitCaveTicks = 0;
                    caves.finishExitToSurface(currentTick);
                    exploreHeadingRad += Math.PI * 0.65;
                    route.clear();
                    statusText = "exited shallow cave; scouting surface";
                    return;
                }
                if (exitCaveTicks > 240) {
                    // Thick mountain roof or slow exit — don't stall; start descending cleanly to prime ore depth!
                    exitCaveTicks = 0;
                    caves.setMode(CaveExplorer.Mode.DEEP_BRANCH_MINE, currentTick);
                    route.clear();
                    statusText = "deep roof above; digging down instead";
                    return;
                }
                Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
                BlockPos exitPos = caves.caveEntryPos();
                boolean useEntry = exitPos != null && exitCaveTicks < 120
                    && feet.getSquaredDistance(exitPos) > 4.0 * 4.0 && exitPos.getY() >= feet.getY() - 2;
                Pathfinder.Goal exitGoal = useEntry
                    ? Pathfinder.Goal.near(exitPos, 2.5)
                    : Pathfinder.Goal.climbToY(Math.max(feet.getY() + 10, 66));
                RouteExecutor.Status st = navigateToward(player, exitGoal, opts, currentTick);
                statusText = "climbing out of shallow cave (y=" + feet.getY() + ")";
                if (st == RouteExecutor.Status.STUCK) {
                    if (useEntry) {
                        // Switch to direct upward staircase on next tick
                        exitCaveTicks = 120;
                        route.clear();
                    } else {
                        exitCaveTicks = 0;
                        caves.setMode(CaveExplorer.Mode.DEEP_BRANCH_MINE, currentTick);
                        route.clear();
                    }
                } else if (st == RouteExecutor.Status.COMPLETE && useEntry) {
                    exitCaveTicks = 120;
                    route.clear();
                }
            }

            case SURFACE_SCOUT -> {
                if (insideCave) {
                    caves.beginExploringCave(feet, currentTick);
                    route.clear();
                    return;
                }
                CaveExplorer.Entrance ent = caves.pickBestSurfaceEntrance(feet);
                if (ent != null) {
                    caves.beginApproachEntrance(ent, currentTick);
                    route.clear();
                    statusText = ent.ravineLike ? "spotted ravine!" : "spotted cave mouth!";
                    return;
                }
                // After ~70s of surface scouting without spotting a cave/ravine (or 3 exhausted shallow caves),
                // transition smoothly into a safe staircase & cardinal branch mine!
                if (caves.surfaceScoutTimedOut(currentTick, 1400) || caves.exhaustedCaveCount() >= 3) {
                    caves.setMode(CaveExplorer.Mode.DEEP_BRANCH_MINE, currentTick);
                    route.clear();
                    statusText = "no deep caves nearby; digging staircase";
                    return;
                }
                exploreForResources(player, world, currentTick, "scouting surface for caves & ravines");
                // Tilt gaze slightly downward over hillsides/cliffs so cave mouths and ravines pop right into sight!
                float moveYaw = (float) (Math.toDegrees(Math.atan2(Math.sin(exploreHeadingRad), Math.cos(exploreHeadingRad))) - 90.0);
                float scanOffset = (float) (Math.sin(currentTick * 0.065) * 38.0);
                motor.lookAtAngles(moveYaw + scanOffset, 12.0f, Motor.LookMode.NORMAL);
            }

            case DEEP_BRANCH_MINE -> {
                // If our staircase/branch mine breaks into a genuinely open downward cavern, explore that cave!
                if (caves.countUnvisitedFrontiers(perception, feet) >= 6) {
                    BlockPos deepCave = caves.selectBestCaveFrontier(perception, feet, player.getYaw(), targetY);
                    if (deepCave != null && deepCave.getY() <= feet.getY() - 3) {
                        caves.beginExploringCave(feet, currentTick);
                        caves.setActiveFrontier(deepCave);
                        route.clear();
                        statusText = "broke into deep cave; exploring";
                        return;
                    }
                }
                tickDescentAndBranchMine(player, world, desiredOre.name().toLowerCase(), targetY, currentTick);
            }
        }
    }

    /** True if a genuine stone/deepslate/dirt cave roof sits above `feet` (ignoring tree leaves/logs). */
    private static boolean hasRockRoofAbove(ClientWorld world, BlockPos feet) {
        for (int dy = 2; dy <= 14; dy++) {
            BlockState st = world.getBlockState(feet.up(dy));
            if (st.isAir() || st.getBlock() instanceof LeavesBlock || st.isIn(BlockTags.LOGS)) continue;
            if (st.blocksMovement()) return true;
        }
        return false;
    }

    private boolean tryStartCaveSafeDescent(ClientPlayerEntity player, ClientWorld world, int targetY) {
        if (descent == null || player.getBlockY() <= targetY + 4) return false;
        SafeDescent.Overlook ov = descent.lastOverlook();
        if (ov == null || ov.dropDepth() < 5 || ov.landingLava() || !ov.floorObserved()) return false;
        if (ov.landingY() < targetY - 14) return false;
        SafeDescent.Decision dec = descent.lastDecision();
        if (!dec.shouldDescend()) return false;
        route.clear();
        descent.startDescent(player, world, descent.preferredMethod(), targetY, null);
        statusText = descent.statusText().isEmpty() ? "safely descending into cavern" : descent.statusText();
        return true;
    }

    private BlockPos findOpportunisticCaveOre(ClientPlayerEntity player, ClientWorld world, Perception.OreKind desired) {
        BlockPos feet = player.getBlockPos();
        int pickTier = bestPickaxeTier(player);
        // Grab nearby exposed iron while caving for diamonds if low on iron (useful for shield/bucket/spare pickaxe)
        if (desired == Perception.OreKind.DIAMOND && pickTier >= 2
                && GuiHands.countItem(player, Items.RAW_IRON) + GuiHands.countItem(player, Items.IRON_INGOT) < 4) {
            List<BlockPos> iron = perception.nearestOreTargets(Perception.OreKind.IRON, feet, 2, blacklistedTargets);
            for (BlockPos p : iron) {
                if (p.getSquaredDistance(feet) <= 7.5 * 7.5 && !perception.isNearKnownLava(p.getX(), p.getY(), p.getZ())) {
                    return p;
                }
            }
        }
        // Grab nearby exposed coal ONLY when low on coal & torches (never waste time on extra coal!)
        if (desired != Perception.OreKind.COAL && pickTier >= 1
                && GuiHands.countItem(player, Items.COAL) < 6 && GuiHands.countItem(player, Items.TORCH) < 8) {
            List<BlockPos> coal = perception.nearestOreTargets(Perception.OreKind.COAL, feet, 2, blacklistedTargets);
            for (BlockPos p : coal) {
                if (p.getSquaredDistance(feet) <= 7.5 * 7.5 && !perception.isNearKnownLava(p.getX(), p.getY(), p.getZ())) {
                    return p;
                }
            }
        }
        return null;
    }

    private void tickDescentAndBranchMine(ClientPlayerEntity player, ClientWorld world,
                                          String oreLabel, int targetY, int currentTick) {
        // Never start digging down from water or a flooded surface shoreline!
        if (isWetSurfaceSpot(player, world)) {
            route.clear();
            exploreForResources(player, world, currentTick, "moving to dry land before mining " + oreLabel);
            return;
        }
        Pathfinder.Options opts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, safeExcavationMode);
        if (player.getBlockY() > targetY + 3 && descentLateralTicks <= 0) {
            RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.reachY(targetY), opts, currentTick);
            statusText = "descending to y=" + targetY + " for " + oreLabel;
            if (st == RouteExecutor.Status.STUCK) {
                // Hit lava/water aquifer or unbreakable barrier while descending: step laterally before continuing down!
                branchDirIndex = (branchDirIndex + 1) & 3;
                descentLateralTicks = 90;
                branchWaypoint = null;
                route.clear();
            }
        } else {
            if (descentLateralTicks > 0) descentLateralTicks--;
            // Cardinal 1x2 branch-mining gallery (2x faster & half the pickaxe wear of diagonal tunnels!)
            int[][] dirs = {{1, 0}, {0, 1}, {-1, 0}, {0, -1}};
            BlockPos feet = player.getBlockPos();
            if (branchWaypoint == null || feet.getSquaredDistance(branchWaypoint) <= 2.5 * 2.5
                    || Math.abs(branchWaypoint.getY() - feet.getY()) > 4) {
                if (branchWaypoint != null && ++branchLegSegments >= 4) {
                    // Every ~64m, jog sideways 4 blocks and reverse direction (classic parallel strip mine!)
                    branchDirIndex = (branchDirIndex + 1) & 3;
                    branchLegSegments = 0;
                    int[] side = dirs[branchDirIndex];
                    branchWaypoint = feet.add(side[0] * 4, 0, side[1] * 4);
                    branchDirIndex = (branchDirIndex + 1) & 3;
                } else {
                    int[] d = dirs[branchDirIndex];
                    int desiredY = Math.max(targetY, Math.min(feet.getY(), targetY + 3));
                    branchWaypoint = new BlockPos(feet.getX() + d[0] * 16, desiredY, feet.getZ() + d[1] * 16);
                }
                route.clear();
            }
            RouteExecutor.Status st = navigateToward(player, Pathfinder.Goal.near(branchWaypoint, 2.2), opts, currentTick);
            statusText = descentLateralTicks > 0
                ? "routing around hazard for " + oreLabel
                : "branch mining at y=" + feet.getY() + " for " + oreLabel;
            if (st == RouteExecutor.Status.STUCK) {
                // Turn 90 degrees cleanly around lava lake / cave wall / fluid pocket!
                branchDirIndex = (branchDirIndex + 1) & 3;
                branchLegSegments = 0;
                branchWaypoint = null;
                route.clear();
            } else if (st == RouteExecutor.Status.COMPLETE) {
                branchWaypoint = null;
                route.clear();
            }
        }
    }

    private void tickCastPortal(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (portal == null) {
            finishActive("failed", "portal caster unavailable", currentTick);
            return;
        }
        if (!portal.isActive()) {
            portal.start(player, world);
        }
        PortalCaster.RunStatus st = portal.tick(player, world, currentTick);
        statusText = portal.statusText();
        if (st == PortalCaster.RunStatus.COMPLETED) {
            finishActive("completed", "cast, ignited, and entered nether portal", currentTick);
        } else if (st == PortalCaster.RunStatus.FAILED) {
            finishActive("failed", "portal casting failed at " + portal.stage().name().toLowerCase(), currentTick);
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

        // 0a. Nether portal goal shortcut: if carrying the casting kit (water_bucket, flint_and_steel, pickaxe, >=9 blocks)
        //     and a lava pool is observed (or portal cast is already underway), cast the shore portal immediately!
        if ("nether_portal".equals(goal) && portal != null && PortalCaster.hasCastingKit(player)) {
            if (portal.isActive() || portal.hasObservedLavaPoolSite(player, client.world) || !perception.observedLava().isEmpty()) {
                return localTask(TaskKind.CAST_PORTAL, "shore", 1, null);
            }
            // Carrying full casting kit on the surface, just scout for a lava pool!
            return localTask(TaskKind.EXPLORE, "lava_pool", 24, null);
        }

        // 0. Food acquisition & cooking:
        //    - If injured/hungry with no food, grab visible food immediately
        //    - When armed on the surface with < 4 edible food and animals/berries right in sight, stock up before caving!
        //    - When carrying raw meat + furnace + fuel (and low on cooked food), cook it into high-saturation cooked meat!
        int edibleFood = GuiHands.countEdibleFood(player, true);
        int rawMeat = countRawMeat(player);
        int cookedMeat = countCookedMeat(player);
        boolean hungryOrHurt = player.getHealth() < 12f || player.getHungerManager().getFoodLevel() <= 10;
        if (hungryOrHurt && edibleFood == 0
                && (!perception.visibleFoodAnimals().isEmpty() || !perception.observedBerries().isEmpty())) {
            return localTask(TaskKind.GATHER_FOOD, "food", 4, null);
        }
        if (hasFurnace && rawMeat > 0 && (rawMeat >= 2 || hungryOrHurt) && cookedMeat < 6
                && GuiHands.countFuelUnits(player) >= 2) {
            return localTask(TaskKind.SMELT, "raw_meat", cookedMeat + Math.min(rawMeat, 6), null);
        }
        if (pickTier >= 2 && player.getBlockY() >= 54 && edibleFood < 4
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
            // Keep enough wood for replacement stone pickaxes + final diamond_pickaxe underground!
            int woodUnits = logs * 4 + planks + sticks;
            if (sticks < 2 && planks < 2 && logs == 0) {
                return localTask(TaskKind.GATHER_WOOD, "logs", 4, null);
            }
            if (!perception.isDiagnosticRevealOres() && player.getBlockY() > 40 && woodUnits < 8) {
                return localTask(TaskKind.GATHER_WOOD, "logs", 4, null);
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

        // 2. If standing on canopy leaves, look for dry ground/water below or punch straight through 1-2 leaf blocks!
        if (world.getBlockState(feet.down()).getBlock() instanceof LeavesBlock) {
            if (descendFromTreeCanopy(player, world)) {
                statusText = "descending from tree canopy";
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
            // If repeatedly trapped in a tight pit/overhang (3+ consecutive stuck turns), climb cleanly out via A*!
            if (exploreFlipCount >= 3) {
                Pathfinder.Options climbOpts = Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true);
                RouteExecutor.Status cst = navigateToward(player, Pathfinder.Goal.climbToY(feet.getY() + 3), climbOpts, currentTick);
                statusText = "climbing out of tight terrain";
                if (cst == RouteExecutor.Status.COMPLETE || cst == RouteExecutor.Status.STUCK) {
                    exploreFlipCount = 0;
                    exploreStuckTicks = 0;
                    exploreLastPos = curPos;
                    route.clear();
                }
                return;
            }
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

        // If a low tree leaf block right over a 1-block grass step is blocking headroom, clear it cleanly in 1 swing!
        BlockPos obstructingLeaf = findLowStepLeafBlocker(player, world, dx, dz);
        if (obstructingLeaf != null) {
            motor.mineBlock(obstructingLeaf, true, false);
            motor.moveToward(target, false, false, false, false);
            return;
        }

        // Crisp 3-point shoulder-width proactive jump over 1-block ledges (never bonk solid low ceilings!)
        boolean headroomClear = motor.hasJumpHeadroom(player);
        boolean stepUpAhead = headroomClear && shouldStepUpAlongHeading(player, world, headingRad);
        boolean jump = stepUpAhead || (player.horizontalCollision && headroomClear) || player.isTouchingWater();

        // Gently pan gaze left/right (+/- 28 deg) while sprinting forward to scan horizon for forests/caves
        float moveYaw = (float) (Math.toDegrees(Math.atan2(dz, dx)) - 90.0);
        float scanOffset = (float) (Math.sin(currentTick * 0.055) * 28.0);
        motor.lookAtAngles(moveYaw + scanOffset, 3.0f, Motor.LookMode.NORMAL);
        motor.moveToward(target, !player.isTouchingWater(), jump, false, false);
    }

    /** 3-point shoulder-width check for a clean climbable 1-block step-up directly along headingRad. */
    private boolean shouldStepUpAlongHeading(ClientPlayerEntity player, ClientWorld world, double headingRad) {
        double dx = Math.cos(headingRad);
        double dz = Math.sin(headingRad);
        double px = -dz;
        double pz = dx;
        double[] dists = {0.68, 1.05};
        double[] offsets = {0.0, 0.26, -0.26};
        int by = player.getBlockY();
        if (!Perception.isPassable(world.getBlockState(player.getBlockPos().up(2)))) {
            return false;
        }
        for (double dist : dists) {
            for (double off : offsets) {
                BlockPos ahead = BlockPos.ofFloored(
                    player.getX() + dx * dist + px * off,
                    by,
                    player.getZ() + dz * dist + pz * off);
                if (Perception.isSolidSupport(world.getBlockState(ahead))
                        && Perception.isPassable(world.getBlockState(ahead.up()))
                        && Perception.isPassable(world.getBlockState(ahead.up(2)))) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Detects low tree leaves directly above a 1-block step-up that would cause head-bonking under a canopy. */
    private BlockPos findLowStepLeafBlocker(ClientPlayerEntity player, ClientWorld world, double dx, double dz) {
        int by = player.getBlockY();
        BlockPos selfTop = player.getBlockPos().up(2);
        if (player.horizontalCollision && world.getBlockState(selfTop).getBlock() instanceof LeavesBlock) {
            return selfTop;
        }
        BlockPos ahead = BlockPos.ofFloored(player.getX() + dx * 0.95, by, player.getZ() + dz * 0.95);
        if (Perception.isSolidSupport(world.getBlockState(ahead)) && Perception.isPassable(world.getBlockState(ahead.up()))) {
            BlockPos leaf = ahead.up(2);
            if (world.getBlockState(leaf).getBlock() instanceof LeavesBlock
                    && player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(leaf)) <= Motor.REACH_SQ) {
                return leaf;
            }
        }
        return null;
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

    /** True when player is in water or on a flooded OPEN-SURFACE shoreline (never triggers inside underground caves!). */
    private boolean isWetSurfaceSpot(ClientPlayerEntity player, ClientWorld world) {
        if (player.isTouchingWater() || player.isSubmergedInWater()) return true;
        BlockPos feet = player.getBlockPos();
        // Inside a shaded cave/tunnel or below sea level, mining pathfinder handles nearby puddles directly!
        if (feet.getY() < 60 || world.getLightLevel(net.minecraft.world.LightType.SKY, feet) < 12) {
            return false;
        }
        int wetNeighbors = 0;
        for (int dx = -2; dx <= 2; dx++) {
            for (int dz = -2; dz <= 2; dz++) {
                if (!world.getFluidState(feet.add(dx, 0, dz)).isEmpty()
                        || !world.getFluidState(feet.add(dx, -1, dz)).isEmpty()) {
                    wetNeighbors++;
                    if (wetNeighbors >= 5) return true;
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

    private BlockPos findImmediateReachableLog(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        for (int dy = -2; dy <= 3; dy++) {
            for (int dx = -2; dx <= 2; dx++) {
                for (int dz = -2; dz <= 2; dz++) {
                    BlockPos p = feet.add(dx, dy, dz);
                    if (blacklistedTargets.contains(p)) continue;
                    if (world.getBlockState(p).isIn(BlockTags.LOGS)
                            && player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(p)) <= Motor.REACH_SQ
                            && motor.findAimPoint(p) != null) {
                        return p;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Escape a treetop canopy spawn cleanly: walk off a nearby safe edge if one exists,
     * otherwise punch through the leaf block directly underfoot (after checking safe ground below!)
     * so continuous dark-oak forest roofs never stall the player!
     */
    private boolean descendFromTreeCanopy(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        BlockPos edge = findSafeCanopyExit(player, world);
        if (edge != null) {
            motor.moveToward(Vec3d.ofBottomCenter(edge), false, false, false, true);
            return true;
        }
        // Continuous canopy (e.g. dark oak roof): verify safe non-hazard landing within 12 blocks below, then break underfoot leaves!
        boolean safeBelow = false;
        for (int dy = 1; dy <= 12; dy++) {
            BlockState below = world.getBlockState(feet.down(dy));
            if (Perception.isHazardBlock(below)) return false;
            if (below.getFluidState().isIn(net.minecraft.registry.tag.FluidTags.WATER)) {
                safeBelow = true;
                break;
            }
            if (Perception.isSolidSupport(below) && !(below.getBlock() instanceof LeavesBlock)) {
                safeBelow = dy <= 9; // safe drop (<= 6 fall dmg, usually 0..2 after dropping through leaf layers)
                break;
            }
        }
        if (safeBelow && world.getBlockState(feet.down()).getBlock() instanceof LeavesBlock) {
            motor.mineBlock(feet.down(), true, false);
            return true;
        }
        return false;
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

    /**
     * Approach a workstation (furnace or crafting table) until BOTH within reach AND in unobstructed line-of-sight,
     * walking around corners or carving an obstructing corner rock if occluded, so opening NEVER stalls behind a wall!
     */
    private void approachAndInteractWorkstation(ClientPlayerEntity player, ClientWorld world, BlockPos pos,
                                                int currentTick, String walkLabel, String openLabel) {
        double eyeDistSq = player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(pos));
        boolean inReach = eyeDistSq <= Motor.REACH_SQ;
        boolean hasLos = inReach && motor.findAimPoint(pos) != null;

        if (hasLos && workstationOpenStuckTicks < 35) {
            workstationOpenStuckTicks++;
            motor.interactBlock(pos);
            statusText = openLabel;
            return;
        }

        // Either out of reach, occluded behind a corner block, or failed to open from current angle:
        // route right next to the workstation using mining-capable A* so we walk around corners cleanly!
        boolean closeOccluded = eyeDistSq <= 3.8 * 3.8;
        Pathfinder.Goal wsGoal = closeOccluded
            ? Pathfinder.Goal.near(pos, 1.45)
            : Pathfinder.Goal.interactReach(pos, 3.1);
        RouteExecutor.Status st = navigateToward(player, wsGoal,
            Pathfinder.Options.mining(scaffoldCount(player), player.getHealth() > 10f, true), currentTick);

        if (workstationOpenStuckTicks >= 35 && hasLos && st == RouteExecutor.Status.COMPLETE) {
            workstationOpenStuckTicks = 0;
            motor.interactBlock(pos);
            statusText = openLabel;
            return;
        }

        // If already within reach & route couldn't move closer while line-of-sight is still blocked by a corner stone/dirt block,
        // clear that single safe obstructing corner block to restore direct view of the workstation!
        if (!hasLos && inReach && (st == RouteExecutor.Status.COMPLETE || st == RouteExecutor.Status.STUCK)) {
            BlockPos blocker = findSafeOccludingBlock(player, world, pos);
            if (blocker != null) {
                motor.mineBlock(blocker, true, false);
                statusText = "clearing corner to reach workstation";
                return;
            }
        }
        if (st == RouteExecutor.Status.COMPLETE) {
            workstationOpenStuckTicks = 0;
        }
        statusText = walkLabel;
    }

    /** Raycast from eye to target workstation center to find a single safe diggable corner block blocking sight. */
    private BlockPos findSafeOccludingBlock(ClientPlayerEntity player, ClientWorld world, BlockPos target) {
        Vec3d eye = player.getEyePos();
        Vec3d center = Vec3d.ofCenter(target);
        net.minecraft.util.hit.BlockHitResult hit = world.raycast(new net.minecraft.world.RaycastContext(
            eye, center, net.minecraft.world.RaycastContext.ShapeType.OUTLINE,
            net.minecraft.world.RaycastContext.FluidHandling.NONE, player));
        if (hit.getType() != net.minecraft.util.hit.HitResult.Type.BLOCK) return null;
        BlockPos hp = hit.getBlockPos();
        if (hp.equals(target) || hp.equals(target.down())) return null;
        if (eye.squaredDistanceTo(Vec3d.ofCenter(hp)) > Motor.REACH_SQ) return null;
        BlockState st = world.getBlockState(hp);
        if (st.isAir() || !st.getFluidState().isEmpty()) return null;
        if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st)) return null;
        if (st.isOf(Blocks.CRAFTING_TABLE) || st.isOf(Blocks.FURNACE) || st.isOf(Blocks.CHEST) || st.isOf(Blocks.OBSIDIAN)) {
            return null;
        }
        if (perception.isNearKnownLava(hp.getX(), hp.getY(), hp.getZ())) return null;
        if (perception.isNearKnownFluidAboveOrSide(hp.getX(), hp.getY(), hp.getZ())) return null;
        return hp;
    }

    private static int remainingIronPickDurability(ClientPlayerEntity player) {
        int best = 0;
        var inv = player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack st = inv.getStack(i);
            if (st.isOf(Items.IRON_PICKAXE)) {
                best = Math.max(best, st.getMaxDamage() - st.getDamage());
            }
        }
        return best;
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
            BlockPos headroomFirst = findHeadroomBlockerForLowTarget(player, world, smeltChoreTarget);
            if (headroomFirst != null) {
                motor.mineBlock(headroomFirst, true, false);
                statusText = "clearing headroom while smelting (" + remSec + "s)";
                return true;
            }
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
        if (pickTier >= 1 && GuiHands.countItem(player, Items.COAL) < 8) {
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

    static boolean isMeatSmeltTarget(String target) {
        if (target == null) return false;
        String clean = target.toLowerCase().replace("minecraft:", "").trim();
        return clean.equals("raw_meat") || clean.equals("meat") || clean.equals("food")
            || clean.contains("beef") || clean.contains("pork") || clean.contains("mutton")
            || clean.contains("chicken") || clean.contains("rabbit");
    }

    private static Item resolveSmeltInput(String target, ClientPlayerEntity p) {
        if (!isMeatSmeltTarget(target)) return Items.RAW_IRON;
        String clean = target.toLowerCase().replace("minecraft:", "").trim();
        if (clean.contains("beef") && GuiHands.countItem(p, Items.BEEF) > 0) return Items.BEEF;
        if (clean.contains("pork") && GuiHands.countItem(p, Items.PORKCHOP) > 0) return Items.PORKCHOP;
        if (clean.contains("mutton") && GuiHands.countItem(p, Items.MUTTON) > 0) return Items.MUTTON;
        if (clean.contains("chicken") && GuiHands.countItem(p, Items.CHICKEN) > 0) return Items.CHICKEN;
        if (clean.contains("rabbit") && GuiHands.countItem(p, Items.RABBIT) > 0) return Items.RABBIT;
        return findBestRawMeat(p);
    }

    private static Item findBestRawMeat(ClientPlayerEntity p) {
        Item[] raw = {Items.BEEF, Items.PORKCHOP, Items.MUTTON, Items.CHICKEN, Items.RABBIT};
        for (Item item : raw) if (GuiHands.countItem(p, item) > 0) return item;
        return null;
    }

    private static int countRawMeat(ClientPlayerEntity p) {
        return GuiHands.countItem(p, Items.BEEF) + GuiHands.countItem(p, Items.PORKCHOP)
            + GuiHands.countItem(p, Items.MUTTON) + GuiHands.countItem(p, Items.CHICKEN)
            + GuiHands.countItem(p, Items.RABBIT);
    }

    private static int countCookedMeat(ClientPlayerEntity p) {
        return GuiHands.countItem(p, Items.COOKED_BEEF) + GuiHands.countItem(p, Items.COOKED_PORKCHOP)
            + GuiHands.countItem(p, Items.COOKED_MUTTON) + GuiHands.countItem(p, Items.COOKED_CHICKEN)
            + GuiHands.countItem(p, Items.COOKED_RABBIT);
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
