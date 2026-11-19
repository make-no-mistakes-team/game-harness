package io.gameharness.pilot;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Measures actual progress; recovery is a bounded normal-input controller, not a new route planner. */
final class PilotStallGuard {
    private static final int IDLE_TICKS = 150;
    private static final int MINING_TICKS = 235;
    private static final int FURNACE_TICKS = 245;
    private static final int INCIDENT_TICKS = 650;
    private static final int DRY_FOOTING_TICKS = 110;
    private static final int PROBE_TICKS = 46;
    private static final int RETRY_TICKS = 145;
    private static final int ANGLE_WINDOW = 64;
    private static final int SPIN_TICKS = 45;
    private static final float RECOVERY_TURN_LIMIT = 250;
    private static final int HISTORY = 64;
    private static final int MAX_CUTS = 2;
    private static final int STEP_TICKS = 85;
    private static final double STEP_CENTER = 0.14;
    private static final double STEP_CLEARANCE = 3.08; // 1.25-block jump plus 1.8-block standing height and margin.
    private static final Predicate<ItemStack> TORCH = s -> s.isOf(Items.TORCH);
    private static final Predicate<ItemStack> STEP = s -> s.isOf(Items.COBBLESTONE) || s.isOf(Items.COBBLED_DEEPSLATE)
        || s.isOf(Items.DIRT);

    private enum Phase { WATCH, PENDING, SCOUT, BACKTRACK, WALK, LIGHT, CUT, STEP, RETRY, FAILED }
    private enum StepStage { CENTER, HEADROOM, SUPPORT, JUMP, LAND }

    record Report(int incidents, int attempts, int recoveries, int failures, String phase, String detail,
                  long eventSequence, int incidentTick) {}

    private final MinecraftClient client;
    private final PilotBody body;
    private final PilotHands hands;
    private final PilotTools tools;
    private final Predicate<BlockPos> protectedBlock;
    private final Predicate<BlockHitResult> safeSupport;
    private final Consumer<BlockPos> reached;
    private final BlockPos[] walked = new BlockPos[HISTORY];
    private final BlockPos[] footprints = new BlockPos[HISTORY];
    private final BlockPos[] breakHistory = new BlockPos[24];
    private final BlockPos[] route = new BlockPos[4];
    private final Vec3d[] travelCredits = new Vec3d[16];
    private final float[] yawWindow = new float[ANGLE_WINDOW];
    private final byte[] reversalsWindow = new byte[ANGLE_WINDOW];
    private final Set<BlockPos> triedStances = new HashSet<>();
    private final Set<BlockPos> rejectedStances = new HashSet<>();
    private final Set<BlockPos> triedCuts = new HashSet<>();
    private final int[] inventory = new int[Registries.ITEM.size()];
    private final int[] inventorySample = new int[inventory.length];
    private final Item[] sampledItems = new Item[PlayerInventory.OFF_HAND_SLOT + 1];
    private int[] itemIds = new int[sampledItems.length];
    private int[] sampledIds = new int[sampledItems.length];
    private int itemKinds;
    private ClientWorld world;
    private Phase phase = Phase.WATCH;
    private Report report = new Report(0, 0, 0, 0, "watch", "", 0, 0);
    private int incidents, attempts, recoveries, failures, tick, incidentTick, entered, lastUseful;
    private int walkedCount, footprintCount, creditCount, brokenCount, novelCells, movedCells, retryCuts;
    private int frameBlocks, meals, mineSince, lastCrackTick, crackStage, furnaceSince, furnaceSeen;
    private long eventSequence, craftSequence, surveySequence, settledSurvey, retrySurvey;
    private BlockPos lastGround, mining, cooking, incidentFrom;
    private Vec3d anchor;
    private float cookProgress, previousYaw, yawTravel, yawNet, recoveryYaw, glanceYaw, driveYaw;
    private int sampledAngles, previousTurn, reversals, glanceSince;
    private boolean inventoryKnown, dark, lampTried, stepTried, backtrackTried, tookControl, priorityAim;
    private boolean glanceTried, glancing;
    private boolean workBroke, resourceBroke;
    private BlockPos from, to, cut;
    private Vec3d cutAim;
    private Direction bearing;
    private int proof, probeSince, driveSince, routeLength, routeIndex, cutCount, itemBefore;
    private boolean cutFinished;
    private StepStage stepStage;
    private int stepSince;
    private Block stepBlock;
    private BlockState stepBase;

    PilotStallGuard(MinecraftClient client, PilotBody body, PilotHands hands, PilotTools tools,
                    Predicate<BlockPos> protectedBlock, Predicate<BlockHitResult> safeSupport,
                    Consumer<BlockPos> reached) {
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.tools = tools;
        this.protectedBlock = protectedBlock;
        this.safeSupport = safeSupport;
        this.reached = reached;
    }

    Report report() { return report; }
    String status() { return "stall recovery: " + report.detail(); }
    String failure() { return phase == Phase.FAILED ? "stopped: " + status() : null; }
    boolean ownsRecovery() { return phase != Phase.WATCH && phase != Phase.RETRY; }

    /** Caller owns deduplication: only newly camera-validated proof cells advance the sequence. */
    void surveyReceipt(long sequence) {
        if (sequence > surveySequence) surveySequence = sequence;
    }

    /** Existing vanilla client player break receipt, not an attack request or an air-block guess. */
    void broken(BlockPos position, BlockState state) {
        if (phase == Phase.CUT && position.equals(cut)) {
            cutFinished = true;
            return;
        }
        if (phase != Phase.WATCH && phase != Phase.RETRY && (phase != Phase.PENDING || tookControl)
                || contains(breakHistory, position)) return;
        breakHistory[brokenCount++ % breakHistory.length] = position.toImmutable();
        workBroke = true;
        resourceBroke |= state.isIn(BlockTags.LOGS) || state.isIn(BlockTags.IRON_ORES)
            || state.isIn(BlockTags.COAL_ORES) || state.isIn(BlockTags.DIAMOND_ORES) || state.isOf(Blocks.OBSIDIAN);
    }

    /** Only an observed furnace screen with relevant input and actual burning supplies this grace. */
    void cooking(int now, BlockPos station, float fraction) {
        if (station == null || !(fraction > 0 && fraction < 1)) return;
        if (furnaceSince == 0) {
            cooking = station;
            furnaceSince = furnaceSeen = now;
            cookProgress = fraction;
        } else if (station.equals(cooking) && fraction > cookProgress) {
            furnaceSeen = now;
            cookProgress = fraction;
        }
    }

    void observe(int now, int confirmedFrameBlocks, int confirmedMeals, String activity) {
        tick = now;
        if (world != client.world) resetWorld();
        var player = client.player;
        sampleAngles(player.getYaw());
        Vec3d feet = player.getPos();
        boolean grounded = dryGround();
        if (grounded) {
            BlockPos cell = player.getBlockPos();
            if (!cell.equals(lastGround)) {
                lastGround = cell.toImmutable();
                walked[walkedCount++ % HISTORY] = lastGround;
                movedCells++;
                if (!contains(footprints, cell)) {
                    footprints[footprintCount++ % HISTORY] = lastGround;
                    novelCells++;
                }
            }
        }
        var receipt = hands.lastCraftReceipt();
        long sequence = receipt == null ? 0 : receipt.sequence();
        boolean crafted = sequence != craftSequence;
        craftSequence = sequence;
        boolean framed = confirmedFrameBlocks > frameBlocks;
        frameBlocks = confirmedFrameBlocks;
        boolean fed = confirmedMeals > meals;
        meals = confirmedMeals;
        boolean surveyed = surveySequence > settledSurvey;
        settledSurvey = surveySequence;
        int gain = inventoryGain();
        boolean normal = phase == Phase.WATCH;
        if (phase == Phase.RETRY && workBroke) retryCuts++;
        double distance = feet.squaredDistanceTo(anchor);
        boolean newTravel = grounded && novelCells >= 2 && distance >= 4.0;
        boolean knownTravel = grounded && movedCells >= 4 && distance >= 25.0 && awayFromCredits(feet);
        boolean wetTravel = (player.isTouchingWater() || player.hasVehicle()) && distance >= 16.0 && awayFromCredits(feet);
        boolean effect = workBroke || crafted || framed || fed || surveyed || gain != 0;
        if ((normal || phase == Phase.PENDING && !tookControl)
                && (effect || newTravel || knownTravel || wetTravel)) {
            if (knownTravel || wetTravel) travelCredits[creditCount++ % travelCredits.length] = feet;
            markUseful(feet, effect);
            if (!normal) transition(Phase.WATCH, "ordinary play advanced before recovery took control");
        } else if (phase == Phase.RETRY) {
            // A recovery step, its dropped dirt, or walking back to the old locus is not a success.
            boolean sustained = tick - entered >= 45 && grounded && movedCells >= 3 && novelCells >= 2
                && distance >= 10.0 && feet.squaredDistanceTo(Vec3d.ofBottomCenter(incidentFrom)) >= 12.0;
            if (crafted || framed || resourceBroke || tick - entered >= 25 && gain == 2
                    || tick - entered >= 45 && (sustained || retryCuts >= 3 || surveySequence - retrySurvey >= 3)) {
                recoveries++;
                markUseful(feet, true);
                transition(Phase.WATCH, "ordinary play advanced after the recovery attempt");
            }
        }
        workBroke = resourceBroke = false;
        int idle = tick - lastUseful;
        if (phase != Phase.WATCH || hands.busy() && idle < 300) return;
        boolean spinning = idle >= SPIN_TICKS && distance <= 2.25 && yawTravel >= 275
            && (Math.abs(yawNet) >= 170 || reversals >= 2);
        if (!spinning && idle < IDLE_TICKS) return;
        if (verifiedMining(lastUseful) || verifiedFurnace()) return;
        String cause = spinning
            ? "local turn budget: " + Math.round(yawTravel) + "deg travel, " + Math.round(yawNet)
                + "deg net, " + reversals + " reversals in " + Math.min(sampledAngles, ANGLE_WINDOW) + " ticks"
            : "no settled progress for " + idle + " ticks";
        detect(cause + " while " + activity);
    }

    /** Actual danger, fall or feeding behavior retains the camera; it is not a search sweep. */
    void priorityAim() {
        priorityAim = true;
        clearAngles();
    }

    private void sampleAngles(float yaw) {
        float delta = MathHelper.wrapDegrees(yaw - previousYaw);
        previousYaw = yaw;
        if (priorityAim) {
            priorityAim = false;
            return;
        }
        if (phase != Phase.WATCH) {
            if (tookControl && phase != Phase.RETRY && phase != Phase.PENDING) recoveryYaw += Math.abs(delta);
            return;
        }
        int i = sampledAngles % ANGLE_WINDOW;
        if (sampledAngles++ >= ANGLE_WINDOW) {
            yawTravel -= Math.abs(yawWindow[i]);
            yawNet -= yawWindow[i];
            reversals -= reversalsWindow[i];
        }
        int sign = delta > 2 ? 1 : delta < -2 ? -1 : 0;
        boolean reversed = sign != 0 && previousTurn != 0 && sign != previousTurn;
        if (sign != 0) previousTurn = sign;
        yawWindow[i] = delta;
        reversalsWindow[i] = (byte) (reversed ? 1 : 0);
        yawTravel += Math.abs(delta);
        yawNet += delta;
        if (reversed) reversals++;
    }

    private void clearAngles() {
        sampledAngles = previousTurn = reversals = 0;
        yawTravel = yawNet = 0;
    }

    /** Feed a recoverable local skill stop before the outer client ends the run. */
    void skillBlocked(String reason) {
        if (phase == Phase.WATCH) detect(reason);
        else if (phase == Phase.RETRY) nextAttempt(reason);
    }

    /** Called only after the existing danger, hands, screen and food owners have declined this tick. */
    boolean takeTurn(Runnable replan) {
        if (phase == Phase.WATCH) return false;
        if (phase == Phase.FAILED) return true;
        if (tick - incidentTick >= INCIDENT_TICKS) {
            fail("incident deadline reached in " + report.phase() + " (" + report.detail() + ")");
            return true;
        }
        if (phase == Phase.RETRY) {
            if (tick - entered < RETRY_TICKS || verifiedMining(entered) || verifiedFurnace()) return false;
            nextAttempt("ordinary play returned to the same local stall");
        }
        if (phase == Phase.PENDING) {
            if (tick == entered) return true; // Preserve the trigger in ordinary tick telemetry.
            if (!dryGround()) {
                if (tick - incidentTick < DRY_FOOTING_TICKS) return false;
                fail("no stable dry footing from which to attempt safe recovery");
                return true;
            }
            tookControl = true;
            replan.run();
            scanFromHere();
        }
        if (recoveryYaw >= RECOVERY_TURN_LIMIT
                && (phase == Phase.SCOUT || phase == Phase.BACKTRACK || phase == Phase.CUT)) {
            String reason = "bounded recovery turn budget exhausted (" + Math.round(recoveryYaw) + "deg)";
            if (stepTried || !dryGround() || hands.count(STEP) == 0) fail(reason + "; no safe step available");
            else startStep(reason + "; checking a temporary step without another sweep");
            return true;
        }
        switch (phase) {
            case SCOUT -> scout();
            case BACKTRACK -> backtrack();
            case WALK -> move();
            case LIGHT -> light();
            case CUT -> cut();
            case STEP -> step();
            default -> { }
        }
        return true;
    }

    private void resetWorld() {
        world = client.world;
        Arrays.fill(walked, null);
        Arrays.fill(footprints, null);
        Arrays.fill(travelCredits, null);
        Arrays.fill(breakHistory, null);
        walkedCount = footprintCount = creditCount = brokenCount = 0;
        lastGround = null;
        inventoryKnown = false;
        previousYaw = client.player.getYaw();
        markUseful(client.player.getPos(), true);
        if (phase != Phase.WATCH) transition(Phase.WATCH, "client world changed");
    }

    private void markUseful(Vec3d feet, boolean receipt) {
        lastUseful = tick;
        anchor = feet;
        novelCells = movedCells = 0;
        clearAngles();
        mineSince = 0;
        mining = null;
        if (receipt) furnaceSince = 0;
    }

    /** Compare total owned items, not slot order, selected hotbar, damage, or in-flight GUI transfers. */
    private int inventoryGain() {
        if (hands.busy() || client.currentScreen != null) return 0;
        var owned = client.player.getInventory();
        int kinds = 0;
        for (int i = 0; i < owned.size(); i++) {
            ItemStack stack = owned.getStack(i);
            if (stack.isEmpty()) continue;
            Item item = stack.getItem();
            int id = Item.getRawId(item);
            if (inventorySample[id] == 0) {
                sampledItems[kinds] = item;
                sampledIds[kinds++] = id;
            }
            inventorySample[id] += stack.getCount();
        }
        int gain = 0;
        if (inventoryKnown) {
            for (int i = 0; i < kinds; i++) {
                int id = sampledIds[i];
                if (inventorySample[id] <= inventory[id]) continue;
                if (taskItem(sampledItems[i])) {
                    gain = 2;
                    break;
                }
                gain = 1;
            }
        }
        for (int i = 0; i < itemKinds; i++) inventory[itemIds[i]] = 0;
        for (int i = 0; i < kinds; i++) {
            int id = sampledIds[i];
            inventory[id] = inventorySample[id];
            inventorySample[id] = 0;
        }
        int[] prior = itemIds;
        itemIds = sampledIds;
        sampledIds = prior;
        itemKinds = kinds;
        inventoryKnown = true;
        return gain;
    }

    private static boolean taskItem(Item item) {
        return item != Items.DIRT && item != Items.COBBLESTONE && item != Items.COBBLED_DEEPSLATE
            && item != Items.TUFF && item != Items.STONE && item != Items.GRASS_BLOCK && item != Items.ROOTED_DIRT
            && item != Items.STICK && !item.getRegistryEntry().isIn(ItemTags.LEAVES);
    }

    private boolean verifiedMining(int since) {
        if (tick - since > IDLE_TICKS + MINING_TICKS || client.currentScreen != null
                || !client.options.attackKey.isPressed() || client.interactionManager == null
                || !client.interactionManager.isBreakingBlock()) return false;
        BlockHitResult selected = body.selectedFace();
        if (selected == null) return false;
        int crack = client.interactionManager.getBlockBreakingProgress();
        if (mineSince == 0) {
            mining = selected.getBlockPos();
            mineSince = lastCrackTick = tick;
            crackStage = crack;
        } else if (!mining.equals(selected.getBlockPos()) || crack < crackStage) {
            return false;
        } else if (crack > crackStage) {
            lastCrackTick = tick;
            crackStage = crack;
        }
        return tick - mineSince <= MINING_TICKS && tick - lastCrackTick <= 50;
    }

    private boolean verifiedFurnace() {
        return furnaceSince != 0 && tick - furnaceSince <= FURNACE_TICKS && tick - furnaceSeen <= 85;
    }

    private void detect(String reason) {
        incidents++;
        incidentTick = tick;
        incidentFrom = client.player.getBlockPos().toImmutable();
        triedStances.clear();
        rejectedStances.clear();
        triedCuts.clear();
        triedStances.add(incidentFrom);
        rejectedStances.add(incidentFrom);
        cutCount = 0;
        recoveryYaw = 0;
        dark = lampTried = stepTried = backtrackTried = tookControl = false;
        glanceTried = glancing = false;
        transition(Phase.PENDING, reason + " at " + incidentFrom.toShortString());
    }

    private void scanFromHere() {
        from = client.player.getBlockPos().toImmutable();
        bearing = client.player.getHorizontalFacing();
        routeIndex = routeLength = proof = 0;
        glancing = false;
        to = null;
        transition(Phase.SCOUT, "checking alternate visible ground from " + from.toShortString());
    }

    private void scout() {
        if (!dryGround()) return;
        if (!from.equals(client.player.getBlockPos())) {
            scanFromHere();
            return;
        }
        if (to != null) {
            if (checkStance()) startWalk();
            else if (tick - probeSince >= PROBE_TICKS) {
                rejectedStances.add(to);
                to = null;
            }
            return;
        }
        if (lampTried && client.player.getPitch() > 65 && tick - entered < 18) {
            body.turn(client.player.getYaw(), 40);
            return;
        }
        if (visibleStance()) return;
        if (!backtrackTried && planBacktrack()) {
            transition(Phase.BACKTRACK, "checking recorded footing at " + to.toShortString());
            return;
        }
        if (!glanceTried || glancing) {
            if (!glancing) {
                glanceTried = glancing = true;
                glanceSince = tick;
                glanceYaw = client.player.getYaw() + ((incidents & 1) == 0 ? 55 : -55);
            }
            if (tick - glanceSince < 24 && Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - glanceYaw)) > 8) {
                body.turn(glanceYaw, 40);
                return;
            }
            glancing = false;
            if (visibleStance()) return;
        }
        if (dark && !lampTried && hands.count(TORCH) > 0) {
            lampTried = true;
            itemBefore = hands.count(TORCH);
            attempts++;
            transition(Phase.LIGHT, "trying one light on the currently stood-on support");
        } else if (cutCount < MAX_CUTS) {
            cut = null;
            cutFinished = false;
            transition(Phase.CUT, "checking the current view for a non-supporting natural obstruction");
        } else startStep("checking clearance for one temporary step on current support");
    }

    private boolean visibleStance() {
        Vec3d eye = client.player.getEyePos();
        for (int i = 0; i < 12; i++) {
            BlockPos cell = from.offset(direction(i & 3)).up(switch (i / 4) {
                case 1 -> 1;
                case 2 -> -1;
                default -> 0;
            });
            if (triedStances.contains(cell)) continue;
            Vec3d point = Vec3d.ofBottomCenter(cell).add(0, -0.07, 0);
            BlockHitResult support = body.terrain(point, eye.distanceTo(point) + 0.05).orElse(null);
            if (support == null || support.getSide() != Direction.UP || !support.getBlockPos().equals(cell.down())
                    || !fullSupport(support)) continue;
            triedStances.add(cell);
            nominate(cell);
            proof = 1;
            glancing = false;
            return true;
        }
        BlockHitResult outlined = body.selectedFace();
        if (outlined != null && body.perceive(outlined.getPos(), eye.distanceTo(outlined.getPos()) + 0.08).isEmpty())
            dark = true;
        return false;
    }

    private Direction direction(int option) {
        boolean leftFirst = (incidents & 1) != 0;
        return switch (option) {
            case 0 -> leftFirst ? bearing.rotateYCounterclockwise() : bearing.rotateYClockwise();
            case 1 -> bearing;
            case 2 -> leftFirst ? bearing.rotateYClockwise() : bearing.rotateYCounterclockwise();
            default -> bearing.getOpposite();
        };
    }

    private void nominate(BlockPos cell) {
        to = cell;
        proof = 0;
        probeSince = tick;
    }

    private boolean checkStance() {
        Vec3d floor = Vec3d.ofBottomCenter(to);
        Vec3d eye = client.player.getEyePos();
        if (proof == 0) {
            Vec3d point = floor.add(0, -0.07, 0);
            body.aim(point);
            if (!body.aligned(point)) return false;
            BlockHitResult support = body.terrain(point, eye.distanceTo(point) + 0.05).orElse(null);
            if (support == null) {
                dark |= body.outlined(to.down());
                return false;
            }
            if (!support.getBlockPos().equals(to.down()) || support.getSide() != Direction.UP || !fullSupport(support)) {
                rejectedStances.add(to);
                probeSince = tick - PROBE_TICKS;
                return false;
            }
            proof++;
        }
        if (proof <= 2) {
            double height = proof == 1 ? 0.35 : 1.68;
            Vec3d clearance = floor.add(0, height, 0);
            body.aim(clearance);
            if (!body.aligned(clearance)) return false;
            double dx = (to.getX() - from.getX()) * 0.25;
            double dz = (to.getZ() - from.getZ()) * 0.25;
            if (!body.clearTerrain(clearance.add(dz, 0, -dx)) || !body.clearTerrain(clearance.add(-dz, 0, dx)))
                return false;
            proof++;
            if (proof == 2) return false;
        }
        if (to.getY() > from.getY()) {
            Vec3d head = eye.add((to.getX() - from.getX()) * 0.32, 0.58, (to.getZ() - from.getZ()) * 0.32);
            body.aim(head);
            if (!body.aligned(head) || !body.clearTerrain(head)) return false;
        }
        return !body.hazardAhead(yaw(floor.subtract(client.player.getPos())), 1.45);
    }

    private boolean planBacktrack() {
        backtrackTried = true;
        int oldest = Math.max(0, walkedCount - HISTORY);
        for (int i = walkedCount - 1; i > oldest; --i) {
            if (!from.equals(walked[i % HISTORY])) continue;
            int length = 0;
            BlockPos prior = from;
            for (int j = i - 1; j >= oldest && length < route.length; --j) {
                BlockPos cell = walked[j % HISTORY];
                if (!neighbor(prior, cell) || cell.equals(from) || triedStances.contains(cell)
                        || length > 1 && cell.equals(route[length - 2])) break;
                route[length++] = cell;
                prior = cell;
            }
            if (length > 0) {
                routeLength = length;
                routeIndex = 0;
                nominate(route[0]);
                return true;
            }
        }
        // A bend, jump or diagonal crossing can interrupt the recorded chain. One
        // remembered adjacent cell is enough to try, not enough to skip sight checks.
        for (int i = walkedCount - 1; i >= oldest; --i) {
            BlockPos cell = walked[i % HISTORY];
            if (!neighbor(from, cell) || triedStances.contains(cell)) continue;
            route[0] = cell;
            routeLength = 1;
            routeIndex = 0;
            nominate(cell);
            return true;
        }
        return false;
    }

    private void backtrack() {
        if (!dryGround()) return;
        if (!from.equals(client.player.getBlockPos()) || tick - probeSince >= PROBE_TICKS) {
            triedStances.add(to);
            rejectedStances.add(to);
            boolean moved = routeIndex != 0 && from.equals(client.player.getBlockPos());
            routeLength = routeIndex = 0;
            to = null;
            if (moved) retry("retreated to " + from.toShortString() + "; the next footing was not verified");
            else transition(Phase.SCOUT, "recently traveled footing no longer proved safe");
        } else if (checkStance()) startWalk();
    }

    private void startWalk() {
        triedStances.add(to);
        attempts++;
        driveSince = 0;
        transition(Phase.WALK, (routeLength == 0 ? "committing to visible stance " : "backtracking to ")
            + to.toShortString());
    }

    private void move() {
        var player = client.player;
        Vec3d landing = Vec3d.ofBottomCenter(to);
        Vec3d delta = landing.subtract(player.getPos());
        if (dryGround() && to.equals(player.getBlockPos()) && delta.horizontalLengthSquared() < 0.46) {
            reached.accept(to);
            if (routeLength != 0 && ++routeIndex < routeLength) {
                from = to;
                nominate(route[routeIndex]);
                transition(Phase.BACKTRACK, "rechecking the next recorded footing");
            } else retry("reached " + to.toShortString() + "; requiring ordinary-play progress");
            return;
        }
        float face = yaw(delta);
        if (tick - entered > 48 || driveSince != 0 && tick - driveSince > 22
                || driveSince != 0 && Math.abs(MathHelper.wrapDegrees(face - driveYaw)) > 30
                || delta.horizontalLengthSquared() > 3.2 || body.hazardAhead(face, 1.45)
                || player.isTouchingWater() || player.getY() < Math.min(from.getY(), to.getY()) - 0.25) {
            rejectedStances.add(to);
            routeLength = routeIndex = 0;
            scanFromHere();
            return;
        }
        if (delta.horizontalLengthSquared() < 0.05) return;
        body.turn(face, to.getY() > from.getY() ? 9 : 28);
        if (Math.abs(MathHelper.wrapDegrees(player.getYaw() - face)) > 11) return;
        if (driveSince == 0) {
            driveSince = tick;
            driveYaw = face;
        }
        if (to.getY() > from.getY() && player.getY() < to.getY() - 0.20 && player.isOnGround()) body.jump();
        body.walkDownTo(landing);
    }

    private void light() {
        if (hands.count(TORCH) < itemBefore || tick - entered > 67 || !dryGround()) {
            if (hands.count(TORCH) < itemBefore) triedStances.retainAll(rejectedStances);
            scanFromHere();
            return;
        }
        if (!hands.equip(TORCH)) return;
        BlockPos support = client.player.getBlockPos().down();
        body.turn(client.player.getYaw(), 89);
        BlockHitResult selected = body.selectedFace();
        if (selected != null && selected.getBlockPos().equals(support) && selected.getSide() == Direction.UP) {
            body.sneak();
            if (client.player.isSneaking()) body.use(support, Direction.UP);
        }
    }

    private void cut() {
        if (!dryGround()) return;
        if (!from.equals(client.player.getBlockPos())) {
            scanFromHere();
            return;
        }
        if (cutFinished) {
            BlockPos opened = cut.getY() == from.getY() ? cut : cut.down();
            triedStances.remove(opened);
            rejectedStances.remove(opened);
            cutFinished = false;
            scanFromHere();
            return;
        }
        if (tick - incidentTick > INCIDENT_TICKS - 92) {
            startStep("checking clearance for one temporary step on current support");
            return;
        }
        if (cut == null) {
            BlockHitResult witness = cutCount < MAX_CUTS ? visibleCut() : null;
            if (witness == null) {
                startStep("checking clearance for one temporary step on current support");
                return;
            }
            cut = witness.getBlockPos().toImmutable();
            triedCuts.add(cut);
            cutAim = witness.getPos().lerp(Vec3d.ofCenter(cut), 0.08);
            probeSince = tick;
            cutCount++;
            attempts++;
            transition(Phase.CUT, "clearing witnessed obstruction " + cut.toShortString() + " with best available tool");
        }
        if (tick - probeSince > 64 || body.hazardAhead(yaw(cutAim.subtract(client.player.getPos())), 1.5)) {
            cut = null;
            return;
        }
        body.aim(cutAim);
        if (!body.aligned(cutAim)) return;
        double distance = client.player.getEyePos().distanceTo(cutAim);
        BlockHitResult seen = body.perceive(cutAim, distance + 0.06).orElse(null);
        if (seen == null || !seen.getBlockPos().equals(cut)) {
            cut = null;
            return;
        }
        BlockState state = client.world.getBlockState(seen.getBlockPos());
        if (!naturalObstruction(state) || !tools.canHarvest(state) || !state.getFluidState().isEmpty()) {
            cut = null;
            return;
        }
        if (!tools.readyFor(state)) return;
        BlockHitResult selected = body.selectedFace();
        if (selected != null && selected.getBlockPos().equals(cut) && selected.getSide() == seen.getSide())
            body.mine(cut);
    }

    private BlockHitResult visibleCut() {
        Vec3d eye = client.player.getEyePos();
        for (int i = 0; i < 8; ++i) {
            // Try head-level first. Only camera-admitted near faces can justify a cut.
            BlockPos cell = from.offset(direction(i & 3)).up(1 - i / 4);
            if (triedCuts.contains(cell) || contains(footprints, cell.up()) || protectedBlock.test(cell)) continue;
            Vec3d point = Vec3d.ofCenter(cell);
            BlockHitResult seen = body.perceive(point, eye.distanceTo(point) + 0.06).orElse(null);
            if (seen == null || !seen.getBlockPos().equals(cell)
                    || body.hazardAhead(yaw(point.subtract(client.player.getPos())), 1.5)) continue;
            BlockState state = client.world.getBlockState(seen.getBlockPos());
            if (naturalObstruction(state) && state.getFluidState().isEmpty() && tools.canHarvest(state)) return seen;
        }
        return null;
    }

    private static boolean naturalObstruction(BlockState state) {
        // Avoid stations, construction blocks, logs, gravel/sand and all special/valuable blocks.
        return state.isIn(BlockTags.LEAVES) && state.contains(LeavesBlock.PERSISTENT) && !state.get(LeavesBlock.PERSISTENT)
            || state.isOf(Blocks.DIRT) || state.isOf(Blocks.GRASS_BLOCK) || state.isOf(Blocks.ROOTED_DIRT)
            || state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.TUFF);
    }

    private void startStep(String description) {
        if (stepTried || !dryGround() || hands.count(STEP) == 0) {
            fail("no verified alternate stance, safe obstruction or usable step material at " + from.toShortString());
            return;
        }
        stepTried = true;
        from = client.player.getBlockPos().toImmutable();
        stepStage = StepStage.CENTER;
        stepSince = tick;
        attempts++;
        transition(Phase.STEP, description);
    }

    private void step() {
        var player = client.player;
        BlockPos feetCell = player.getBlockPos();
        if (player.isTouchingWater() || player.isInLava()
                || !from.equals(feetCell) && !from.up().equals(feetCell)) {
            failStep("left the verified dry column");
            return;
        }
        if (tick - stepSince > STEP_TICKS) {
            failStep(switch (stepStage) {
                case CENTER -> "could not center on the current support";
                case HEADROOM -> "could not verify jump and standing clearance";
                case SUPPORT -> "could not verify the current top face or equip a step block";
                case JUMP -> "did not reach a valid placement window";
                case LAND -> "placement or grounded landing was not confirmed";
            });
            return;
        }
        BlockPos support = from.down();
        Vec3d feet = player.getPos();
        boolean centered = Math.abs(feet.x - from.getX() - 0.5) <= STEP_CENTER
            && Math.abs(feet.z - from.getZ() - 0.5) <= STEP_CENTER;
        if (stepStage == StepStage.CENTER) {
            if (!dryGround() || !from.equals(feetCell)) {
                failStep("lost the dry starting support");
            } else if (!centered) {
                body.centerOnSupport(support);
            } else if (!player.isSneaking() && player.getVelocity().horizontalLengthSquared() <= 0.000144) {
                stepStage = StepStage.HEADROOM;
            }
            return;
        }
        if (stepStage == StepStage.HEADROOM) {
            if (!centered || !dryGround()) {
                failStep("moved before jump clearance was verified");
                return;
            }
            // At this pose the whole tested column, not just the crosshair, must be in view.
            Vec3d overhead = Vec3d.ofBottomCenter(from).add(0, STEP_CLEARANCE, 0);
            double edge = player.getWidth() * 0.5 + STEP_CENTER + 0.01;
            body.turn(player.getYaw(), -89);
            if (player.getPitch() > -86) return;
            if (!body.clearTerrain(overhead) || !body.clearTerrain(overhead.add(-edge, 0, -edge))
                    || !body.clearTerrain(overhead.add(-edge, 0, edge))
                    || !body.clearTerrain(overhead.add(edge, 0, -edge))
                    || !body.clearTerrain(overhead.add(edge, 0, edge)))
                return;
            stepStage = StepStage.SUPPORT;
            transition(Phase.STEP, "jump clearance verified; lining up the current support");
        }
        body.turn(player.getYaw(), 89);
        if (stepStage == StepStage.SUPPORT) {
            if (!centered || !dryGround() || !from.equals(feetCell)) {
                failStep("lost the centered dry starting pose");
                return;
            }
            if (!hands.equip(STEP) || !(player.getMainHandStack().getItem() instanceof BlockItem item)) return;
            if (player.getPitch() < 86) return;
            BlockHitResult seen = stepTop(support);
            if (seen == null) return;
            BlockState state = client.world.getBlockState(seen.getBlockPos());
            if (!fullSupport(seen, state) || state.hasBlockEntity() || state.isOf(Blocks.CRAFTING_TABLE)) {
                failStep("current top is not a safe placement support");
                return;
            }
            if (player.isSneaking() || player.getVelocity().horizontalLengthSquared() > 0.000144) return;
            stepBase = state;
            stepBlock = item.getBlock();
            itemBefore = hands.count(STEP);
            stepStage = StepStage.JUMP;
            transition(Phase.STEP, "jumping once above the verified support");
            body.jump();
            return;
        }
        if (stepStage == StepStage.LAND && dryGround()
                && from.up().equals(feetCell) && Math.abs(feet.y - from.getY() - 1) < 0.01) {
            BlockHitResult seen = stepTop(from);
            if (seen != null && client.world.getBlockState(seen.getBlockPos()).isOf(stepBlock)
                    && hands.count(STEP) < itemBefore) {
                reached.accept(feetCell);
                retry("stood on confirmed temporary step; requiring ordinary-play progress");
            }
            return;
        }
        if (player.isOnGround()) {
            if (tick - entered > 2) failStep(stepStage == StepStage.JUMP
                ? "jump did not clear one block with a visible top face" : "jump landed without a confirmed placement");
        } else if (feet.y >= from.getY() + 1.001 && stepTop(support) != null
                && client.world.getBlockState(support) == stepBase
                && player.getMainHandStack().getItem() instanceof BlockItem item && item.getBlock() == stepBlock) {
            body.use(support, Direction.UP);
            if (stepStage == StepStage.JUMP) {
                stepStage = StepStage.LAND;
                transition(Phase.STEP, "placing one block beneath the airborne feet");
            }
        }
    }

    private BlockHitResult stepTop(BlockPos support) {
        BlockHitResult selected = body.selectedFace();
        if (selected == null || !selected.getBlockPos().equals(support) || selected.getSide() != Direction.UP) return null;
        BlockHitResult seen = body.terrain(selected.getPos().add(0, -0.04, 0), 4.15).orElse(null);
        return seen != null && seen.getBlockPos().equals(support) && seen.getSide() == Direction.UP
            && Math.abs(seen.getPos().y - support.getY() - 1) < 0.01 ? seen : null;
    }

    private void failStep(String reason) {
        fail("temporary step at " + from.toShortString() + ": " + reason);
    }

    private void retry(String reason) {
        anchor = client.player.getPos();
        novelCells = movedCells = retryCuts = 0;
        retrySurvey = surveySequence;
        mineSince = 0;
        mining = null;
        transition(Phase.RETRY, reason);
    }

    private void nextAttempt(String reason) {
        transition(Phase.PENDING, reason);
    }

    private void fail(String reason) {
        failures++;
        transition(Phase.FAILED, reason);
    }

    private void transition(Phase next, String detail) {
        phase = next;
        entered = tick;
        report = new Report(incidents, attempts, recoveries, failures, next.name().toLowerCase(java.util.Locale.ROOT),
            detail, ++eventSequence, incidentTick);
    }

    private boolean dryGround() {
        var player = client.player;
        return player.isOnGround() && !player.isTouchingWater() && !player.isInLava() && !player.hasVehicle();
    }

    private boolean fullSupport(BlockHitResult seen) {
        return fullSupport(seen, client.world.getBlockState(seen.getBlockPos()));
    }

    private boolean fullSupport(BlockHitResult seen, BlockState state) {
        // Side solidity is an attachment rule; vanilla leaves have no solid sides
        // but their collision is a full cube that can carry the player and a block item.
        return safeSupport.test(seen)
            && Block.isShapeFullCube(state.getCollisionShape(client.world, seen.getBlockPos()));
    }

    private boolean awayFromCredits(Vec3d feet) {
        for (Vec3d previous : travelCredits) if (previous != null && previous.squaredDistanceTo(feet) <= 6.25) return false;
        return true;
    }

    private static boolean contains(BlockPos[] cells, BlockPos p) {
        for (BlockPos cell : cells) if (p.equals(cell)) return true;
        return false;
    }

    private static boolean neighbor(BlockPos a, BlockPos b) {
        return Math.abs(a.getY() - b.getY()) <= 1
            && Math.abs(a.getX() - b.getX()) + Math.abs(a.getZ() - b.getZ()) == 1;
    }

    private static float yaw(Vec3d delta) {
        return (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
    }
}
