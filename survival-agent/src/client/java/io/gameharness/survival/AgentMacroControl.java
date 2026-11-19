package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
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
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.enchantment.EnchantmentHelper;
import net.minecraft.enchantment.Enchantments;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.RegistryKeys;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.GameMode;

/** Camera witnesses and short, cancellable vanilla actions. The host sends IDs, never input or source. */
final class AgentMacroControl {
    private static final int OBSERVATION_INTERVAL = 5;
    private static final long PLANNING_IDLE_LIMIT_NS = 3_000_000_000L;
    // Leave time for a bounded probe and rendered camera motion, not just a turn command.
    private static final long CAMERA_DISPATCH_LEAD_NS = 600_000_000L;
    private static final long PLAN_SETTLEMENT_GRACE_NS = 750_000_000L;
    private static final int MAX_AGE = 1_200;
    private static final int MAX_HANDOFF_AGE = 100;
    private static final int MAX_WORK_ADMISSION_AGE = 40;
    private static final int MAX_ROUTE_EDGES = 8;
    private static final int MAX_OFFERS = 16;
    private static final int MAX_MATERIAL_TARGETS = 4_096;
    private static final int APPROACH_SETTLE_TICKS = 3;
    private static final double INSPECT_REACH = 16;
    private static final double PICKUP_STANCE_SQUARED = 1.20 * 1.20;
    private static final double SETTLED_SPEED_SQUARED = 0.001225;
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
        SURVEY("survey", "read", 30), INSPECT("inspect", "read", 30), APPROACH("approach", "low", 32),
        INTERACT("interact", "guarded", 40), COLLECT("collect", "guarded", 38), BREAK("break", "guarded", 120),
        CONTINUE("continue", "guarded", 320), FOLLOW("follow", "guarded", 640),
        WORK_WALK("work_walk", "guarded", 160), WORK_EQUIP("work_equip", "guarded", 120),
        WORK_PLACE("work_place", "guarded", 80);

        final String id, risk;
        final int maxTicks;
        Verb(String id, String risk, int maxTicks) {
            this.id = id; this.risk = risk; this.maxTicks = maxTicks;
        }
    }

    /** All world geometry and entity identities stay private to the native thread. */
    private record Floor(BlockPos pos, BlockState state, Vec3d landing) {}
    private record Face(BlockHitResult hit, BlockState state) {}
    private record Key(Verb verb, BlockPos pos, int entity, String activity, Direction side, BlockState state) {
        Key(Verb verb, BlockPos pos, int entity, String activity) {
            this(verb, pos, entity, activity, null, null);
        }
    }
    private record Recipe(String id, Item result, Predicate<ItemStack> material, int amount, int sticks) {}
    private static final Recipe PLANKS = new Recipe("planks", null, LOG, 1, 0);
    private static final Recipe STICKS = new Recipe("stick", Items.STICK, PLANK, 2, 0);
    private static final Recipe BENCH = new Recipe("crafting_table", Items.CRAFTING_TABLE, PLANK, 4, 0);
    private static final Recipe[] BENCH_RECIPES = {
        new Recipe("wooden_pickaxe", Items.WOODEN_PICKAXE, PLANK, 3, 2),
        new Recipe("stone_pickaxe", Items.STONE_PICKAXE, STONE, 3, 2),
        new Recipe("iron_pickaxe", Items.IRON_PICKAXE, IRON, 3, 2),
        new Recipe("diamond_pickaxe", Items.DIAMOND_PICKAXE, DIAMOND, 3, 2)
    };

    private record Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
                         Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe,
                         AgentDryCaveRoute.Offer route) {
        Offer(String id, Key key, String summary, String evidence, float yaw, float pitch,
              Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe) {
            this(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe, null);
        }
    }
    private record Snapshot(long epoch, Map<String, Offer> offers) {}
    private record Intent(String id, int life, long epoch, long basis, long expires, String opportunity, String skillHash) {}
    private record Handoff(int life, long epoch, long basis, long expires) {}
    private record Planning(int life, long epoch, long basis, String id, long noticedAt) {}
    private record WorkMailbox(boolean present, AgentWorkOrder order) {}
    private record Inbox(boolean active, Intent intent, Handoff handoff, Planning planning, WorkMailbox work) {}
    private record Camera(float yaw, float pitch) {}
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
            counts.forEach((item, tally) -> tally.remaining = tally.original);
            for (int i = 0; i < inventory.size(); ++i) {
                ItemStack stack = inventory.getStack(i);
                if (stack.isEmpty()) continue;
                Tally tally = counts.get(stack.getItem());
                if (tally == null || (tally.remaining -= stack.getCount()) < 0) return stack.getItem();
            }
            return null;
        }
    }

    private static final class Action {
        final Intent intent;
        final Offer offer;
        final long started, startedAt, startingFrame;
        final Vec3d position;
        final float yaw, pitch;
        final int itemCount;
        final InventoryWitness walkInventory;
        final Camera camera;
        final ItemStack harvestTool;
        final Offer[] keepVisible;
        final float pathYaw, pathPitch;
        boolean drove, fired, broken, purposefulMotion, durable;
        float lastCrack;
        long firedAt, pickupDisappeared, craftJob, priorCraftReceipt, settledAt, lastMissingFrame;
        int missingFaceFrames;
        String unexpectedPickup;
        Screen opened;
        Vec3d destination;
        double distanceLeft;
        int workSlot, executions, handLoss;
        Item tracked;

        Action(Intent intent, Offer offer, MinecraftClient client, long tick, long now, long frame, int itemCount,
               Offer[] keepVisible, float chosenWalkPitch) {
            this.intent = intent;
            this.offer = offer;
            started = tick;
            startedAt = now;
            startingFrame = frame;
            position = client.player.getPos();
            yaw = client.player.getYaw();
            pitch = client.player.getPitch();
            this.itemCount = itemCount;
            this.keepVisible = keepVisible;
            pathYaw = offer.floor == null ? yaw : heading(offer.floor.landing.x - position.x, offer.floor.landing.z - position.z);
            pathPitch = Float.isNaN(chosenWalkPitch) ? MathHelper.clamp(pitch, 12, 42) : chosenWalkPitch;
            if (offer.floor != null) distanceLeft = horizontalSquared(position, offer.floor.landing);
            if (offer.route != null) distanceLeft = horizontalSquared(position, Vec3d.ofBottomCenter(offer.route.endpoint()));
            walkInventory = offer.key.verb == Verb.APPROACH || offer.key.verb == Verb.FOLLOW
                ? new InventoryWitness(client.player.getInventory()) : null;
            harvestTool = offer.key.verb == Verb.BREAK ? client.player.getMainHandStack().copy() : ItemStack.EMPTY;
            camera = switch (offer.key.verb) {
                case SURVEY -> new Camera(offer.yaw, offer.pitch);
                case INSPECT -> {
                    Vec3d point = offer.face.hit.getPos().subtract(client.player.getEyePos());
                    yield new Camera(heading(point.x, point.z), (float) Math.toDegrees(
                        Math.atan2(-point.y, Math.hypot(point.x, point.z))));
                }
                default -> null;
            };
        }
    }

    private static final class WorkSession {
        AgentWorkOrder order;
        final AgentWorkOrder.Budget budget;
        final Set<BlockPos> rejected = new HashSet<>();
        final Set<Integer> rejectedDrops = new HashSet<>();
        long deadline;
        BlockPos lastHarvest;
        long lastHarvestTick;
        Item lastHarvestItem;
        long lastEffectTick;
        String lastEffect;
        int confirmedBreaks, confirmedCrafts, confirmedPlacements, startingStock;
        float sweepStart;
        int sweep, sweepWait;
        String enactedPhase = "hold", enactedStatus = "No physical step has started.";
        String phase = "working", detail = "Current local evidence admits this bounded work order.";

        WorkSession(AgentWorkOrder order, AgentWorkOrder.Budget budget, long deadline) {
            this.order = order;
            this.budget = budget;
            this.deadline = deadline;
        }

        boolean active() { return phase.equals("working"); }
    }

    private final String run, goal;
    private final Ipc ipc;
    private final boolean activated, trial;
    private final LinkedHashMap<Long, Snapshot> snapshots = new LinkedHashMap<>();
    private final LinkedHashMap<Key, String> ids = new LinkedHashMap<>();
    private final Map<Key, String> materialTargets = new HashMap<>();
    private final LinkedHashMap<String, Boolean> consumed = new LinkedHashMap<>();
    private final Set<Key> retiredViews = new HashSet<>();
    private final Set<BlockPos> localSteps = new HashSet<>();
    private final ArrayDeque<String> recent = new ArrayDeque<>(8);
    private final Predicate<ItemStack> safetySpend = this::canSpendSafetyStock;
    private List<Offer> reservedOffers = List.of();
    private static final Offer[] NO_ANCHORS = {};
    private long reservationEpoch, reservationUntil;
    private MinecraftClient client;
    private AgentBody body;
    private AgentHands hands;
    private AgentProgress routeOwner;
    private Offer routeOffer;
    private Screen shown;
    private ClientWorld world;
    private ClientPlayerEntity player;
    private ItemStack scopedMainHand = ItemStack.EMPTY;
    private Vec3d anchor;
    private float surveyYaw;
    private long tick, epoch, nextId, nextMaterialId, lastObservation, inventoryStamp, safetyRevision;
    private long fallbackTicks;
    private long fallbackActions, blockedCount, urgentCount, lastPurposefulTick;
    private long now, idleSince, waitElapsed, waitTotal, waitMaximum, waitOvershoot, nextLocalProbe;
    private long rawNoWorkSince, rawNoWorkMax, rawNoWorkTotal, planningNoticeTick, planningNoticeNanos;
    private int life, surveyOrigin;
    private Inbox input;
    private Action action;
    private WorkSession work;
    private AgentPauseEpisodes.Work continuityWork;
    private long lastHandsEvidence;
    private boolean suspended, visited, owned, hazardClear, lastHazard, quiescent, urgent, blocked, deadlineMeasured;
    private boolean urgentInput;
    private boolean rawPending, rawWorking;
    private String planningState = "awaiting_plan", planningEvidence = "No provider decision is pending.";
    private String activePlanningId, lastPurposefulAction, lastUrgency, blockedReason, localHoldReason;
    private boolean trialUsed, revocationSeen, revocationAcknowledged;
    private String owner = "deterministic";
    private String status = "waiting for a current local plan";

    static AgentMacroControl create(Path directory, String goal) {
        Path macro = directory.resolve("macro");
        String run = directory.getFileName().toString();
        // Startup-only admission. Inactive deterministic runs allocate no channel or thread.
        if (!TOKEN.matcher(run).matches()) return null;
        boolean trial = Ipc.marked(macro, run, "trial.json");
        String marker = Ipc.activeMode(macro, run);
        return trial || marker != null ? new AgentMacroControl(macro, run, goal, marker, trial) : null;
    }

    private AgentMacroControl(Path directory, String run, String goal, String mode, boolean trial) {
        this.run = run;
        this.goal = goal;
        this.activated = mode != null;
        this.trial = trial;
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
            interrupt("The player life or dimension changed.", false);
            retireWork("needs_replan", "interrupted", "The player life or dimension changed.");
            work = null;
            this.life = life;
            world = client.world;
            player = client.player;
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
            reservedOffers = List.of();
            routeOffer = null;
            activePlanningId = null;
            idleSince = now;
            nextLocalProbe = 0;
            blocked = deadlineMeasured = false;
            waitElapsed = 0;
            rawPending = rawWorking = false;
            lastHandsEvidence = hands.workEvidence();
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
        return work == null || work.budget.policy.floors().isEmpty() ? null : safetySpend;
    }

    private boolean canSpendSafetyStock(ItemStack stack) {
        if (work == null || stack.isEmpty()) return true;
        Item item = stack.getItem();
        int floor = work.budget.floor(item);
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

    /** Called only after the existing fall, danger and emergency food controllers declined ownership. */
    void control(AgentProgress progress) {
        visited = true;
        hazardClear = !body.lavaEmergency() && !body.macroLavaNear()
            && !client.player.isOnFire() && !client.player.isInLava() && client.player.hurtTime == 0;

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
        if (!trial && ipc.workMode != null) {
            reconcileWork();
            if (hasActiveWorkOrder()) {
                workTick(progress);
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
            if (!local && (input.intent == null || !input.intent.equals(action.intent))) {
                interrupt("The host withdrew or replaced this intent.", true);
            } else if ((local ? now - action.startedAt >= PLANNING_IDLE_LIMIT_NS : tick > action.intent.expires)
                    || tick - action.started > action.offer.key.verb.maxTicks) {
                interrupt(timeoutDetail(), true);
            } else if (action.offer.route != null && (action.intent.epoch != epoch || !cursorClear())) {
                interrupt("The dry route's dependency epoch or clean-cursor premise changed.", true);
            } else if (!grounded() || !hazardClear || !client.isWindowFocused() || client.getOverlay() != null) {
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
        String refusal = !available() ? "No neutral, grounded, safe first-person view." :
            trial && (trialUsed || !diagnosticVerb(offer.key.verb)) ? "The diagnostic admits one isolated reader action."
            : offer.route != null && intent.skillHash != null ? "Only a direct Terra action may follow this dry route."
            : !trial && intent.skillHash != null && offer.key.verb == Verb.APPROACH
                ? "Reusable skills cannot approach while incidental pickup remains possible."
            : validate(offer, progress);
        if (refusal != null) {
            refuseUnseen(refusal);
            if (ipc.workMode == null || trial) idle(progress, thinking);
            else holdWork();
            return;
        }
        markConsumed(intent.id);
        owner = "terra";
        if (offer.route != null) routeOwner = progress;
        action = new Action(intent, offer, client, tick, now, body.renderedFrame(),
            offer.item == null ? 0 : count(offer.item), NO_ANCHORS, Float.NaN);
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
        if (action.purposefulMotion) return;
        boolean witnessed = false;
        if (action.camera != null && body.renderedFrame() > action.startingFrame && body.hasRecentView()) {
            double distanceBefore = angle(action.yaw, action.pitch, action.camera.yaw, action.camera.pitch);
            double left = angle(player.getYaw(), player.getPitch(), action.camera.yaw, action.camera.pitch);
            witnessed = distanceBefore - left >= 5;
        } else if (action.drove && action.offer.route != null) {
            witnessed = horizontalSquared(action.position, player.getPos()) >= 0.16;
        } else if (action.drove) {
            Vec3d destination = action.offer.floor.landing;
            witnessed = horizontalSquared(action.position, destination) - horizontalSquared(player.getPos(), destination) >= 0.16;
        }
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

    private void reconcileWork() {
        WorkMailbox mailbox = input.work;
        if (hasActiveWorkOrder()) {
            String invalid = !mailbox.present ? "The host withdrew the work order."
                : tick >= work.order.expires() || now >= work.deadline ? "The finite work horizon expired."
                : !hazardClear || work.order.safetyRevision() != safetyRevision ? "The safety premise changed."
                : null;
            if (invalid != null) {
                interrupt(invalid, true);
                retireWork("needs_replan", "interrupted", invalid);
            }
        }
        AgentWorkOrder next = mailbox.order;
        // A mutable echo cannot expand or interrupt the already accepted, immutable permission.
        if (work != null && next != null && work.order.id().equals(next.id())) return;

        if (next != null && !consumed.containsKey(next.id())) {
            updateScope(true);
            Snapshot basis = snapshots.get(next.basis());
            boolean samePolicy = work != null && work.order.policy().equals(next.policy())
                && next.basis() >= work.order.basis();
            boolean compatible = hasActiveWorkOrder() && samePolicy;
            if (next.policy() == null) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work order contains an unsupported target or effect.");
            } else if (next.life() != life || !compatible && next.epoch() != epoch || next.basis() > tick
                    || tick - next.basis() >= MAX_WORK_ADMISSION_AGE || tick >= next.expires()
                    || next.safetyRevision() != safetyRevision || basis == null || basis.epoch != next.epoch()
                    || next.policy().target().goal() != null && !next.policy().target().goal().equals(goal)) {
                markConsumed(next.id());
                receipt(next.id(), next.life(), "refused", "The work basis, preset goal, or safety premise changed.");
            } else if (hazardClear && (action == null || action.durable)) {
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
                    work = new WorkSession(next, samePolicy ? work.budget : new AgentWorkOrder.Budget(next.policy()), deadline);
                    work.sweepStart = player.getYaw();
                    Item goalStock = goalStock(next.policy().target());
                    work.startingStock = goalStock == null ? 0 : count(goalStock);
                }
                markConsumed(next.id());
                receipt(next.id(), life, "accepted", work.detail);
                return;
            }
        }
    }

    private void retireWork(String phase, String result, String detail) {
        if (!hasActiveWorkOrder()) return;
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
        if (action != null) {
            runWorkStep(progress);
            return;
        }
        if (!hazardClear || !grounded() || !client.isWindowFocused() || client.getOverlay() != null
                || client.currentScreen != null || !cursorClear() || !body.hasRecentView() || hands.busy()) {
            enact("hold", "Waiting for safe footing, a rendered view, and neutral controls.");
            return;
        }
        var target = work.order.policy().target();
        Item goalStock = goalStock(target);
        boolean goalReached = goalStock != null && count(goalStock) >= goalAmount(target);
        var missingFloor = missingWorkFloor();
        if (goalReached && missingFloor == null) {
            retireWork("complete", "completed", "The native inventory confirms the requested outcome and declared reserves.");
            holdWork();
            return;
        }
        if (work.lastHarvest != null && tick - work.lastHarvestTick <= 15) {
            Item expected = work.lastHarvestItem;
            if (workPickup(stack -> stack.isOf(expected))) {
                work.lastHarvest = null;
                runWorkStep(progress);
                return;
            }
            Vec3d basin = Vec3d.ofBottomCenter(work.lastHarvest).subtract(player.getEyePos()).add(0, -0.65, 0);
            body.turnFine(heading(basin.x, basin.z),
                (float) Math.toDegrees(Math.atan2(-basin.y, Math.hypot(basin.x, basin.z))));
            if (tick - work.lastHarvestTick <= 8) {
                enact("search", "Checking beside the confirmed harvest for a visible drop; no pickup confirmed yet.");
                return;
            }
        }
        work.lastHarvest = null;
        BlockHitResult tableHit = body.find(state -> state.isOf(Blocks.CRAFTING_TABLE), reach()).orElse(null);
        if (target.item() != null) {
            Item desired = goalReached ? missingFloor.getKey() : target.item();
            int required = goalReached || missingFloor != null && missingFloor.getKey() == desired
                ? Math.max(goalReached ? 0 : target.count(), missingFloor.getValue()) : target.count();
            if (workTowardStock(desired, required - count(desired), tableHit, progress)) runWorkStep(progress);
            else searchWork(goalReached ? "The target is present, but no permitted witnessed source can fill the outstanding "
                + Registries.ITEM.getId(desired) + " reserve."
                : "No witnessed drop, harvest face, or reserve-safe recipe can advance the requested stock.");
            return;
        }
        if (goalReached) {
            if (workTowardStock(missingFloor.getKey(), missingFloor.getValue() - count(missingFloor.getKey()), tableHit, progress))
                runWorkStep(progress);
            else searchWork("The preset result is present, but a declared reserve is not yet fulfilled.");
            return;
        }
        var stage = progress.macroPresetStage(work.budget, tableHit != null);
        if (stage.blocked() != null) {
            retireWork("blocked", "interrupted", stage.blocked());
            holdWork();
        } else if (stage.recipe() != null) {
            if (startWorkRecipe(stage.recipe(), stage.executions(), tableHit)) runWorkStep(progress);
            else searchWork("No safe visible workstation or placement can advance the next preset recipe.");
        } else if (workPickup(stage.pickup()) || workGather(progress, stage.gather())) {
            runWorkStep(progress);
        } else {
            searchWork("No live visible source, suitable tool, or permitted route advances the next preset step.");
        }
    }

    private boolean workTowardStock(Item desired, int quantity, BlockHitResult tableHit, AgentProgress progress) {
        if (workPickup(stack -> stack.isOf(desired))) return true;
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
        return workGather(progress, state -> AgentWorkOrder.harvest(state) == desired);
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
            if (workPickup(matches)) return true;
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
            return workGather(progress, state -> {
                Item harvest = AgentWorkOrder.harvest(state);
                return harvest != Items.AIR && matches.test(new ItemStack(harvest));
            });
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
        var key = face == null ? new Key(verb, null, 0, null) : faceKey(verb, face, null);
        Offer offer = new Offer(null, key, label, "", 0, 0, null, face, drop, item, recipe);
        action = new Action(null, offer, client, tick, now, body.renderedFrame(), item == null ? 0 : count(item),
            NO_ANCHORS, Float.NaN);
        action.durable = true;
        work.detail = label;
        enact(switch (verb) {
            case BREAK -> "harvest";
            case WORK_WALK -> drop == null ? "route" : "collect";
            case CONTINUE -> "craft";
            case WORK_EQUIP -> "equip";
            case WORK_PLACE -> "place";
            default -> "hold";
        }, label);
        status = label;
        return action;
    }

    private boolean workPickup(Predicate<ItemStack> wanted) {
        var seen = body.visibleEntity(entity -> entity instanceof ItemEntity drop && !work.rejectedDrops.contains(drop.getId())
            && wanted.test(drop.getStack()) && roomFor(drop.getStack()), 8.0).orElse(null);
        if (!(seen instanceof ItemEntity found)) return false;
        Item item = found.getStack().getItem();
        BlockPos cell = found.getBlockPos();
        Vec3d destination = Vec3d.ofBottomCenter(cell);
        startWorkStep(Verb.WORK_WALK, "Collect visible " + Registries.ITEM.getId(item), null, found, item, null);
        action.destination = destination;
        action.distanceLeft = horizontalSquared(player.getPos(), destination);
        return true;
    }

    private boolean workGather(AgentProgress progress, Predicate<BlockState> matches) {
        if (!work.budget.canBreak()) return false;
        var found = body.find(state -> matches.test(state) && work.budget.policy.breakAllowed(state), INSPECT_REACH,
            hit -> !work.rejected.contains(hit.getBlockPos())
                && workResourceSafe(hit.getBlockPos(), client.world.getBlockState(hit.getBlockPos()), progress)
                && workToolSlot(hit.getBlockPos(), client.world.getBlockState(hit.getBlockPos())) >= 0).orElse(null);
        if (found == null) return false;
        Face face = face(found);
        BlockPos pos = found.getBlockPos();
        Item item = AgentWorkOrder.harvest(face.state);
        if (!visibleFace(face)) {
            if (horizontalSquared(player.getPos(), Vec3d.ofCenter(pos)) < 1.0) {
                work.rejected.add(pos);
                return false;
            }
            startWorkStep(Verb.WORK_WALK, "Approach witnessed " + blockName(face), face, null, null, null);
            action.destination = Vec3d.ofBottomCenter(pos);
            action.distanceLeft = horizontalSquared(player.getPos(), action.destination);
            return true;
        }
        int tool = workToolSlot(pos, face.state);
        if (tool != player.getInventory().selectedSlot) {
            int slot = tool;
            startWorkStep(Verb.WORK_EQUIP, "Equip a suitable tool for " + blockName(face), face, null, null, null);
            action.workSlot = slot;
            return true;
        }
        startWorkStep(Verb.BREAK, "Harvest witnessed " + blockName(face), face, null, null, null);
        action.tracked = item;
        return true;
    }

    private boolean workResourceSafe(BlockPos pos, BlockState block, AgentProgress progress) {
        if (!progress.macroCanBreak(pos) || pos.getY() < player.getBlockY() || !block.getFluidState().isEmpty()
                || client.world.getBlockState(pos.up()).getBlock() instanceof FallingBlock
                || !roomFor(new ItemStack(AgentWorkOrder.harvest(block)))) return false;
        for (Direction side : Direction.values())
            if (!client.world.getBlockState(pos.offset(side)).getFluidState().isEmpty()) return false;
        return true;
    }

    private int workToolSlot(BlockPos pos, BlockState block) {
        var inventory = player.getInventory();
        int best = -1;
        float speed = 0;
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; i++) {
            ItemStack hand = inventory.getStack(i);
            if (block.isToolRequired() && !hand.isSuitableFor(block)) continue;
            if (!workLootCompatible(hand, block)) continue;
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

    private boolean workLootCompatible(ItemStack hand, BlockState block) {
        return !hand.hasEnchantments() || AgentWorkOrder.harvest(block) == block.getBlock().asItem()
            || EnchantmentHelper.getLevel(world.getRegistryManager().getOrThrow(RegistryKeys.ENCHANTMENT)
                .getOrThrow(Enchantments.SILK_TOUCH), hand) == 0;
    }

    private Map.Entry<Item, Integer> missingWorkFloor() {
        return work.budget.missingFloor(player.getInventory());
    }

    private boolean startWorkRecipe(String key, int executions, BlockHitResult bench) {
        Face face = null;
        if (AgentHands.workTableRecipe(key)) {
            if (bench == null) return findWorkTable(key);
            face = face(bench);
        }
        if (!hands.workCraftable(key, work.budget)) return false;
        startWorkStep(Verb.CONTINUE, "Craft " + key + " within the work budget", face, null, null,
            new Recipe(key, null, null, 0, 0));
        action.executions = executions;
        return true;
    }

    private boolean findWorkTable(String recipe) {
        var known = body.find(state -> state.isOf(Blocks.CRAFTING_TABLE), INSPECT_REACH,
            hit -> !work.rejected.contains(hit.getBlockPos())).orElse(null);
        if (known != null && horizontalSquared(player.getPos(), Vec3d.ofCenter(known.getBlockPos())) > 1.0) {
            startWorkStep(Verb.WORK_WALK, "Approach the witnessed crafting table", face(known), null, null, null);
            action.destination = Vec3d.ofBottomCenter(known.getBlockPos());
            action.distanceLeft = horizontalSquared(player.getPos(), action.destination);
            return true;
        }
        if (!work.budget.canPlace() || !work.budget.policy.placeTable()) return false;
        if (count(Items.CRAFTING_TABLE) == 0) {
            return !recipe.equals("crafting_table") && hands.workCraftable("crafting_table", work.budget)
                && startWorkRecipe("crafting_table", 1, null);
        }
        if (work.budget.limit(Items.CRAFTING_TABLE, count(Items.CRAFTING_TABLE)) < 1) return false;
        var support = body.stationFace(null, pos -> pos.getY() == player.getBlockY()
            && !work.rejected.contains(pos) && client.world.getBlockState(pos).isAir());
        if (support == null || support.getSide() != Direction.UP
                || client.world.getBlockState(support.getBlockPos()).getBlock() instanceof FallingBlock) return false;
        startWorkStep(Verb.WORK_PLACE, "Place the authorized crafting table on visible footing",
            face(support), null, Items.CRAFTING_TABLE, null);
        return true;
    }

    private void searchWork(String reason) {
        // One local discovery sweep is a bounded prerequisite, never evidence of work itself.
        if (work.sweep >= 6) {
            retireWork("blocked", "interrupted", reason);
            holdWork();
            return;
        }
        float yaw = work.sweepStart + 60 * (work.sweep + 1);
        float pitch = work.sweep == 5 ? 34 : 13;
        if (body.renderedDirection(yaw, pitch, 6) || work.sweepWait >= 26) {
            ++work.sweep;
            work.sweepWait = 0;
        } else {
            body.turnScan(yaw, pitch);
            ++work.sweepWait;
        }
        status = "Checking one local view for an authorized source";
        enact("search", reason);
    }

    private void runWorkStep(AgentProgress progress) {
        Verb verb = action.offer.key.verb;
        status = action.offer.summary;
        if (tick - action.started > verb.maxTicks) {
            interrupt(timeoutDetail(), true);
        } else if (!hazardClear || !client.isWindowFocused() || client.getOverlay() != null
                || client.interactionManager == null || client.interactionManager.getCurrentGameMode() != GameMode.SURVIVAL
                || !(grounded() || verb == Verb.WORK_WALK && !player.isTouchingWater() && !player.hasVehicle())) {
            interrupt("The work step lost its safe footing, focus or Survival controls.", true);
        } else switch (verb) {
            case WORK_WALK -> advanceWorkWalk(progress);
            case WORK_EQUIP -> advanceWorkEquip();
            case WORK_PLACE -> advanceWorkPlacement();
            default -> step(progress);
        }
    }

    private void advanceWorkWalk(AgentProgress progress) {
        if (client.currentScreen != null || !cursorClear()) {
            interrupt("A different screen replaced the working view.", false);
            return;
        }
        ItemEntity drop = action.offer.drop;
        if (drop != null) {
            if (count(action.offer.item) > action.itemCount && drop.isRemoved()) {
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                complete("Vanilla confirmed a " + (count(action.offer.item) - action.itemCount) + " item gain of "
                    + Registries.ITEM.getId(action.offer.item) + " after collecting its witnessed drop.");
                return;
            }
            if (drop.isRemoved()) {
                if (action.pickupDisappeared == 0) action.pickupDisappeared = tick;
                if (tick - action.pickupDisappeared > 6)
                    interrupt("The authorized drop disappeared without an inventory gain.", true);
                return;
            }
        }
        double distance = horizontalSquared(player.getPos(), action.destination);
        if (action.drove && distance + 0.008 < action.distanceLeft) {
            action.distanceLeft = distance;
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
        }
        if (!body.hasRecentView()) return;
        if (drop == null && (distance <= 1.35 * 1.35 || visibleFace(action.offer.face)
                && horizontalSquared(action.position, player.getPos()) >= 0.35)) {
            if (settled()) complete("Reached a closer safe stance for the retained witnessed target.");
            return;
        }
        if (drop != null && distance < 0.15 && action.settledAt == 0) action.settledAt = tick;
        if (drop != null && action.settledAt != 0 && tick - action.settledAt > 12) {
            interrupt("The witnessed drop did not enter inventory at its landing.", true);
        } else if (!progress.macroWorkWalk(action.destination)) {
            interrupt("No safe visible lane remains toward the retained target.", true);
        }
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

    private void advanceWorkPlacement() {
        Face support = action.offer.face;
        BlockPos dest = support.hit.getBlockPos().up();
        if (action.fired) {
            if (client.world.getBlockState(dest).isOf(Blocks.CRAFTING_TABLE) && count(Items.CRAFTING_TABLE) < action.itemCount) {
                ++work.confirmedPlacements;
                continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                complete("Vanilla confirmed the authorized table placement and matching inventory decrement.");
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
        if (work.budget.limit(Items.CRAFTING_TABLE, count(Items.CRAFTING_TABLE)) < 1
                || !work.budget.canPlace() || !client.world.getBlockState(dest).isAir()
                || !visible(support) || player.getBoundingBox().intersects(new Box(dest))) {
            interrupt("The placement face, free space or material permission changed.", true);
            return;
        }
        if (!player.getMainHandStack().isOf(Items.CRAFTING_TABLE)) {
            hands.equipForUse(stack -> stack.isOf(Items.CRAFTING_TABLE));
            if (hands.busy()) action.craftJob = hands.jobGeneration();
            return;
        }
        body.sneak();
        if (body.useContact(support.hit, AgentBody.Contact.PLACE,
                player.isSneaking() ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE)) {
            work.budget.placedTable();
            action.fired = true;
            action.firedAt = tick;
        }
    }

    private void idle(AgentProgress progress, boolean thinking) {
        if (trial) {
            status = "holding the isolated trial view";
            state("trial_idle", status);
            return;
        }
        long idleNanos = now - idleSince;
        boolean due = blocked || idleNanos >= PLANNING_IDLE_LIMIT_NS;
        boolean cameraReady = due || idleNanos >= PLANNING_IDLE_LIMIT_NS - CAMERA_DISPATCH_LEAD_NS;
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
                LocalWork work = localOffer(progress, cameraReady);
                if (work == null) {
                    if (due) {
                        block(localHoldReason == null ? "No compatible new camera view or safe adjacent step." : localHoldReason);
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
            block("No new lit resource view or safe adjacent step toward a witnessed feature.");
        } else {
            status = "waiting for a current local plan";
            state(thinking ? "planning_wait" : "awaiting_plan", thinking
                ? "A trusted planning episode is pending." : "No provider decision is pending.");
        }
    }

    private record LocalWork(Offer offer, Offer[] anchors, float walkPitch) {
        LocalWork(Offer offer, Offer[] anchors) { this(offer, anchors, Float.NaN); }
    }

    private LocalWork localOffer(AgentProgress progress, boolean allowCamera) {
        localHoldReason = null;
        Offer inspect = null, survey = null, step = null;
        Vec3d from = client.player.getPos();
        var current = offers(progress);
        // A pinned route needs the same settled source and current view until
        // Terra chooses it. An unrelated local walk would discard that work.
        if (routeOffer != null && offeredOnPlanningBasis(routeOffer)) {
            localHoldReason = "A revalidated dry route is awaiting Terra; no new local action can preserve its source and view.";
            return null;
        }
        Offer[] anchors = visibleAnchors(current);
        if (anchors.length != 0) {
            LocalWork advance = usefulMaterialApproach(current, anchors, progress);
            if (advance != null) return advance;
            if (allowCamera) {
                for (Offer offer : anchors) {
                    Offer perspective = prepareTerrainView(offer, anchors);
                    if (perspective != null) return new LocalWork(perspective, anchors);
                }
                for (Offer offer : anchors) {
                    Offer preparation = prepareView(offer, anchors);
                    if (preparation != null) return new LocalWork(preparation, anchors);
                }
            }
            localHoldReason = "A useful material face is still visible; no new local action can preserve the view.";
            return null;
        }
        BlockHitResult feature = body.find(AgentMacroControl::resource, INSPECT_REACH).orElse(null);
        double improvement = 0.5;
        if (localSteps.size() < 32) localSteps.add(client.player.getBlockPos().down());
        for (Offer offer : current) {
            switch (offer.key.verb) {
                case APPROACH -> {
                    if (feature == null || feature.getPos().squaredDistanceTo(client.player.getEyePos()) <= reach() * reach()
                            || localSteps.size() >= 32 || localSteps.contains(offer.floor.pos)) continue;
                    double benefit = horizontalSquared(from, feature.getPos()) -
                        horizontalSquared(offer.floor.landing, feature.getPos());
                    if (benefit > improvement && validate(offer, progress) == null) {
                        improvement = benefit;
                        step = offer;
                    }
                }
                case INSPECT -> { if (allowCamera && inspect == null && validate(offer, progress) == null) inspect = offer; }
                case SURVEY -> { if (allowCamera && survey == null && validate(offer, progress) == null) survey = offer; }
                default -> { } // Never select an attack, workstation, crafting, or pickup on local authority.
            }
        }
        Offer next = step != null ? step : inspect != null ? inspect : survey;
        return next == null ? null : new LocalWork(next, NO_ANCHORS);
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

    private Offer prepareTerrainView(Offer material, Offer[] anchors) {
        if (material.key.verb != Verb.BREAK || localSteps.size() >= 32
                || horizontalSquared(player.getPos(), Vec3d.ofCenter(material.key.pos)) <= PICKUP_STANCE_SQUARED) return null;
        Face face = material.face;
        Key key = faceKey(Verb.SURVEY, face, "collection_footing");
        if (retiredViews.contains(key)) return null;
        float yaw = player.getYaw();
        float pitch = Math.min(42, player.getPitch() + 28);
        for (; pitch - player.getPitch() >= 9; pitch -= 3) {
            if (retainsAnchors(anchors, player.getPos(), yaw, pitch) && revealsFootingToward(material, yaw, pitch)) {
                return new Offer(material.id, key, "Survey footing below the witnessed resource",
                    "Expose nearer footing for a possible retrieval route while preserving the resource face.",
                    yaw, pitch, null, face, null, null, null);
            }
        }
        return null;
    }

    private boolean revealsFootingToward(Offer material, float yaw, float pitch) {
        Vec3d feet = player.getPos();
        Vec3d source = Vec3d.ofCenter(material.key.pos);
        double distance = horizontalSquared(feet, source);
        BlockPos standing = player.getBlockPos();
        for (Direction direction : CARDINAL) {
            BlockPos adjacent = standing.offset(direction);
            if (localSteps.contains(adjacent.down())) continue;
            Vec3d landing = Vec3d.ofBottomCenter(adjacent);
            if (distance - horizontalSquared(landing, source) <= 0.36) continue;
            // This is the bearing of a candidate floor patch, not a world query.
            // A subsequent real rendered ray still has to admit the floor.
            Vec3d patch = landing.add(0.32 * direction.getOffsetX(), 0, 0.32 * direction.getOffsetZ());
            if (!body.macroRetainsView(patch, feet, yaw, player.getPitch())
                    && body.macroRetainsView(patch, feet, yaw, pitch)) return true;
        }
        return false;
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

    private Offer prepareView(Offer material, Offer[] anchors) {
        Face face = material.face;
        Key key = faceKey(Verb.INSPECT, face, "contact");
        if (retiredViews.contains(key) || body.renderedAim(face.hit.getPos(), 8)) return null;
        Vec3d eye = player.getEyePos();
        Vec3d bearing = face.hit.getPos().subtract(eye);
        float yaw = heading(bearing.x, bearing.z);
        float pitch = (float) Math.toDegrees(Math.atan2(-bearing.y, Math.hypot(bearing.x, bearing.z)));
        if (!retainsAnchors(anchors, player.getPos(), yaw, pitch)) return null;
        return new Offer(material.id, key, "Center the actionable " + blockName(face),
            "Prepare the same witnessed face without touching it.", 0, 0, null, face, null, null, null);
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
            case SURVEY -> retiredViews.contains(offer.key) || offer.key.entity != surveyOrigin || anchor == null
                || horizontalSquared(anchor, player.getPos()) > 0.64
                || angle(player.getYaw(), player.getPitch(), offer.yaw, offer.pitch) < 5
                ? "The bounded survey is already done or its origin changed." : null;
            case INSPECT -> retiredViews.contains(offer.key) || !visible(offer.face, INSPECT_REACH)
                || player.getRotationVec(1).dotProduct(offer.face.hit.getPos().subtract(player.getEyePos()).normalize()) > 0.996
                ? "The feature is already centered, inspected, or no longer visible." : null;
            case APPROACH -> !floorCurrent(offer.floor) ? "The adjacent footing is no longer visible and clear." :
                !body.macroNoVisiblePickup(offer.floor.landing) ? "A visible pickup overlaps the walking lane, or the view cannot check it." : null;
            case COLLECT -> dropVisible(offer) && floorCurrent(offer.floor)
                && dropNearLanding(offer.drop, offer.floor) && roomFor(offer.drop.getStack())
                ? null : "The drop, adjacent footing, or inventory room changed.";
            case BREAK -> visibleFace(offer.face) && canBreak(offer.face, progress)
                ? null : "The resource, harvest tool, or safe reach changed.";
            case INTERACT -> visibleFace(offer.face) && useAvailable() ? null : "The workstation or use control changed.";
            case CONTINUE -> ingredients(offer.recipe) && (offer.face == null
                ? !client.options.inventoryKey.isUnbound() : visibleFace(offer.face) && useAvailable())
                ? null : "The recipe ingredients, storage, or workstation changed.";
            case FOLLOW -> routeCurrent(offer, progress) ? null : "The exact witnessed dry segment or its source changed.";
            case WORK_WALK, WORK_EQUIP, WORK_PLACE -> "This operation requires a native work order.";
        };
    }

    private void step(AgentProgress progress) {
        Offer offer = action.offer;
        status = offer.summary;
        if (client.currentScreen != null && offer.key.verb != Verb.INTERACT && offer.key.verb != Verb.CONTINUE) {
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
            case SURVEY -> {
                var player = client.player;
                if (horizontalSquared(action.position, player.getPos()) > 0.12) {
                    interrupt("The survey lost its stationary stance.", true);
                } else if (!body.hasRecentView()) {
                    // A missed frame is not motion or a negative witness. Hold until the
                    // next rendered view or the survey's existing bounded deadline.
                    return;
                } else if (body.renderedFrame() > action.startingFrame
                        && body.renderedDirection(action.camera.yaw, action.camera.pitch, 4)
                        && angle(action.yaw, action.pitch, player.getYaw(), player.getPitch()) >= 5) {
                    complete("The first-person camera rendered the requested survey angle.");
                } else body.turnScan(action.camera.yaw, action.camera.pitch);
            }
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
            case APPROACH, COLLECT -> walk(offer);
            case BREAK -> breakWitnessedFace(offer.face, progress);
            case INTERACT, CONTINUE -> useOrCraft(offer);
            case FOLLOW -> followRoute(offer, progress);
            case WORK_WALK, WORK_EQUIP, WORK_PLACE -> throw new IllegalStateException("Expected work step dispatch");
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
            switch (progress.followDryRoute(offer.route)) {
                case RUNNING -> { return; }
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
                || Math.abs(player.getY() - destination.y) > 0.055) {
            interrupt("The player did not remain on the authorized dry endpoint.", true);
        } else if (settled() && tick - action.settledAt >= APPROACH_SETTLE_TICKS) {
            complete("Settled at the authorized dry route endpoint after " + offer.route.edges() + " witnessed level edges.");
        }
    }

    private void breakWitnessedFace(Face face, AgentProgress progress) {
        BlockPos target = face.hit.getBlockPos();
        boolean mayBreak = action.broken;
        if (!mayBreak) {
            if (action.durable) {
                ItemStack hand = player.getMainHandStack();
                int loss = AgentMiningStock.maxLoss(hand, face.state, world, target);
                mayBreak = work.budget.canBreak() && work.budget.policy.breakAllowed(face.state)
                    && workResourceSafe(target, face.state, progress)
                    && (!face.state.isToolRequired() || hand.isSuitableFor(face.state)) && loss >= 0 && workLootCompatible(hand, face.state)
                    && (loss == 0 || work.budget.limit(hand.getItem(), count(hand.getItem())) >= loss);
                action.handLoss = loss;
            } else {
                mayBreak = canBreak(face, progress);
            }
        }
        if (action.broken) {
            continuityWork = AgentPauseEpisodes.Work.NOVELTY;
            if (action.durable) {
                work.lastHarvest = target;
                work.lastHarvestItem = action.tracked;
                work.lastHarvestTick = tick;
            }
            complete("Vanilla reported this player's break of the witnessed " + blockName(face) + ".");
        } else if (!mayBreak
                || !ItemStack.areItemsAndComponentsEqual(action.harvestTool, client.player.getMainHandStack())) {
            interrupt("The selected harvest tool or protected footing changed.", true);
        } else if (!body.hasRecentView()) {
            // Only an already held crack may bridge a brief render gap. The Body
            // still rechecks the actual exact crosshair, contact region and state.
            if (action.fired) body.continueMine(target);
        } else {
            BlockHitResult live = body.macroMineWitness(face.hit, reach());
            if (live == null) {
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
        var player = client.player;
        Floor floor = offer.floor;
        boolean collect = offer.drop != null;
        String pickup = unexpectedPickup();
        if (pickup != null) {
            interrupt(pickup, true);
            return;
        }
        if (collect && offer.drop.isRemoved()) {
            if (action.pickupDisappeared == 0) action.pickupDisappeared = tick;
            if (count(offer.item) > action.itemCount) {
                if (settled()) {
                    continuityWork = AgentPauseEpisodes.Work.NOVELTY;
                    complete("The witnessed drop disappeared and the matching inventory count increased.");
                }
            } else if (tick - action.pickupDisappeared > 6) {
                interrupt("The drop disappeared without a matching inventory gain.", true);
            }
            return;
        }
        if (!body.hasRecentView()) return; // Do not issue another movement tick from a missing frame.
        if (!collect && tick != action.started && !body.macroNoVisiblePickup(floor.landing)) {
            interrupt("A visible pickup overlaps the walking lane, or the view cannot check it.", true);
            return;
        }
        if (!body.macroFlatLane(floor.pos, floor.state, floor.landing) || (collect && (!dropVisible(offer)
                || !dropNearLanding(offer.drop, floor)))) {
            interrupt("The witnessed drop or flat walking lane is no longer safe.", true);
            return;
        }
        Vec3d position = player.getPos();
        double remaining = horizontalSquared(position, floor.landing);
        if (action.drove && remaining + 0.008 < action.distanceLeft) {
            continuityWork = AgentPauseEpisodes.Work.ROUTE;
            action.distanceLeft = remaining;
        }
        if (remaining <= 0.1225 && action.drove && horizontalSquared(action.position, position) >= 0.16
                && player.getBlockPos().equals(floor.pos.up())) {
            if (!collect) {
                if (!settled()) action.settledAt = 0;
                else if (action.settledAt == 0) action.settledAt = tick;
                else if (tick - action.settledAt >= APPROACH_SETTLE_TICKS)
                    complete("Reached the adjacent witnessed tile and stopped after actual displacement.");
            }
            return;
        }
        action.settledAt = 0;
        float yaw = action.keepVisible.length == 0 ? heading(floor.landing.x - position.x, floor.landing.z - position.z)
            : action.pathYaw;
        float pitch = action.pathPitch;
        body.macroFlatWalk(floor.landing, yaw, pitch);
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
            if (result != null && result.sequence() > action.priorCraftReceipt
                    && result.recipe().equals(offer.recipe.id) && result.items() > 0 && client.currentScreen == null) {
                if (action.durable) work.confirmedCrafts += result.executions();
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
        if (!visible(offer.face) || !useAvailable()) {
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
                : ingredients(offer.recipe) && hands.craft(offer.recipe.id))) {
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
        if (action != null && action.offer.key.verb == Verb.BREAK && action.fired
                && action.offer.face.hit.getBlockPos().equals(pos) && action.offer.face.state == state && !action.broken) {
            action.broken = true;
            if (action.durable) {
                ++work.confirmedBreaks;
                work.budget.broken(action.harvestTool.getItem(), action.handLoss);
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
        if (!input.active) {
            rawWorking = false;
            if (activated && !revocationSeen) {
                revocationSeen = true;
                quiescent = false;
                ++epoch;
                ++safetyRevision;
                publish(null);
            }
            if (action != null) interrupt(safety, true);
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
                || action.offer.key.verb == Verb.FOLLOW || action.offer.key.verb == Verb.WORK_WALK))
            action.drove = client.options.forwardKey.isPressed() || !action.durable && action.drove;
        if (action != null && action.offer.key.verb == Verb.BREAK && (action.durable || owner.equals("terra")))
            action.fired |= client.options.attackKey.isPressed();
        float crack = advancingCrack();
        if (crack > 0) continuityWork = AgentPauseEpisodes.Work.CRACK;
        long handsEvidence = hands.workEvidence();
        if (continuityWork == null && (action != null && action.craftJob != 0 || owner.equals("safety"))
                && handsEvidence != lastHandsEvidence) continuityWork = AgentPauseEpisodes.Work.GUI;
        lastHandsEvidence = handsEvidence;
        rawWorking = continuityWork != null;
        if (rawWorking && action != null && action.durable && tick - lastPurposefulTick >= 10)
            purposeful("work " + action.offer.key.verb.id + ": " + continuityWork.name());
        boolean due = tick - lastObservation >= OBSERVATION_INTERVAL || lastObservation == 0;
        updateScope(due);
        // Ordinary local work may continue on the very next tick. Only an observed
        // promotion barrier (or an isolated trial) advertises a held neutral window.
        quiescent = (trial || handoffCurrent(input.handoff)) && visited && owned && available();
        if (due) publish(progress, crack);
    }

    /** Death/transport shutdown leaves vanilla in charge of the old screen and cursor. */
    void suspend(long tick, String reason) {
        if (suspended) return;
        suspended = true;
        this.tick = tick;
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

    boolean neutral() { return body != null && body.keysNeutral() && !hands.busy() && action == null; }
    boolean hazardClear() { return hazardClear; }

    private boolean available() {
        return observable() && neutral() && settled() && !client.player.isUsingItem() && !client.player.isSprinting()
            && !client.player.isSneaking() && !client.interactionManager.isBreakingBlock();
    }

    private boolean observable() {
        return action == null && observableWorld();
    }

    private boolean observableWorld() {
        return visited && grounded() && hazardClear && cursorClear() && client.currentScreen == null
            && client.getOverlay() == null && client.isWindowFocused() && body.hasRecentView();
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
        return offer.drop != null && !offer.drop.isRemoved() && body.visibleEntity(entity -> entity == offer.drop, 3.25)
            .filter(entity -> offer.drop.getStack().isOf(offer.item)).isPresent();
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

    private static Key faceKey(Verb verb, Face face, String activity) {
        return new Key(verb, face.hit.getBlockPos(), 0, activity, face.hit.getSide(), face.state);
    }

    private double reach() { return Math.min(4.25, client.player.getBlockInteractionRange() - 0.15); }

    private boolean useAvailable() {
        return !client.options.useKey.isUnbound() && !client.player.isUsingItem() && !client.player.isSneaking()
            && !client.interactionManager.isBreakingBlock();
    }

    private boolean canBreak(Face face, AgentProgress progress) {
        return resource(face.state) && canBreak(face.hit.getBlockPos(), face.state, progress);
    }

    private boolean canBreak(BlockPos pos, BlockState state, AgentProgress progress) {
        return pos.getY() >= client.player.getBlockY()
            && progress.macroCanBreak(pos) && !client.options.attackKey.isUnbound()
            && (!state.isToolRequired() || client.player.getMainHandStack().isSuitableFor(state));
    }

    private static boolean resource(BlockState state) {
        return state.isIn(BlockTags.LOGS) || state.isIn(BlockTags.COAL_ORES) || state.isIn(BlockTags.IRON_ORES)
            || state.isIn(BlockTags.DIAMOND_ORES) || state.isIn(BlockTags.COPPER_ORES) || state.isIn(BlockTags.GOLD_ORES)
            || state.isIn(BlockTags.REDSTONE_ORES) || state.isIn(BlockTags.LAPIS_ORES) || state.isIn(BlockTags.EMERALD_ORES);
    }

    private static boolean station(BlockState state) { return state.isOf(Blocks.CRAFTING_TABLE) || state.isOf(Blocks.FURNACE); }
    private static String blockName(Face face) { return Registries.BLOCK.getId(face.state.getBlock()).toString(); }

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
        if (action == null && (anchor == null || horizontalSquared(anchor, pos) > 0.64 || Math.abs(pos.y - anchor.y) > 0.25)) {
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
        var offers = new ArrayList<Offer>(MAX_OFFERS);
        for (Offer reserved : reservation()) if (liveMaterialFace(reserved, progress)) offers.add(reserved);
        if (!trial) addDryRouteOffer(offers, progress);
        var player = client.player;
        float pitch = player.getPitch();
        survey(offers, "footing", surveyYaw, 42, "Survey the nearby ground", "A fixed downward camera angle from the current stance.");
        survey(offers, "left", surveyYaw - 55, 31, "Survey left from this stance", "A bounded first-person turn over nearby terrain.");
        survey(offers, "right", surveyYaw + 55, 31, "Survey right from this stance", "A bounded first-person turn over nearby terrain.");

        BlockPos standing = player.getBlockPos().down();
        for (Direction direction : CARDINAL) {
            BlockPos floor = standing.offset(direction);
            if (client.options.forwardKey.isUnbound() || body.macroFloor(floor) == null) continue;
            var witness = new Floor(floor, client.world.getBlockState(floor), Vec3d.ofBottomCenter(floor.up()));
            if (!body.macroFlatLane(floor, witness.state, witness.landing)) continue;
            var key = new Key(Verb.APPROACH, floor, 0, null);
            if (body.macroNoVisiblePickup(witness.landing)) {
                offer(offers, key, "Walk to the adjacent flat tile", "Lit full top and clear dry sweep, " +
                    bearing(witness.landing, player.getPos(), player.getYaw()) + " from the current view.",
                    0, pitch, witness, null, null, null, null);
            }
            var seen = body.visibleEntity(entity -> entity instanceof ItemEntity item && dropNearLanding(item, witness)
                && !item.getStack().isEmpty() && roomFor(item.getStack()), 3.25).orElse(null);
            if (seen instanceof ItemEntity drop) {
                Item item = drop.getStack().getItem();
                offer(offers, new Key(Verb.COLLECT, floor, drop.getId(), null), "Collect visible " + Registries.ITEM.getId(item),
                    "A rendered drop is on this adjacent dry tile; the matching item fits in inventory.",
                    0, pitch, witness, null, drop, item, null);
            }
        }
        var station = body.find(AgentMacroControl::station, reach()).orElse(null);
        if (station != null) {
            Face face = face(station);
            inspect(offers, face);
            if (useAvailable() && visibleFace(face)) {
                offer(offers, faceKey(Verb.INTERACT, face, null),
                    "Open visible " + blockName(face), "A lit workstation face is inside vanilla use reach.",
                    0, pitch, null, face, null, null, null);
                if (face.state.isOf(Blocks.CRAFTING_TABLE)) for (Recipe recipe : BENCH_RECIPES) craftOffer(offers, recipe, face);
            }
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
        var resourceView = body.find(AgentMacroControl::resource, INSPECT_REACH, hit ->
            !retiredViews.contains(faceKey(Verb.INSPECT, face(hit), null)) && !body.renderedAim(hit.getPos(), 7))
            .orElse(null);
        if (resourceView != null) inspect(offers, face(resourceView));
        if (!client.options.inventoryKey.isUnbound()) {
            craftOffer(offers, PLANKS, null);
            craftOffer(offers, STICKS, null);
            craftOffer(offers, BENCH, null);
        }
        return offers;
    }

    private void addDryRouteOffer(List<Offer> offers, AgentProgress progress) {
        AgentDryCaveRoute.Offer route = progress.dryRouteOffer();
        if (route == null || route.edges() < 1 || route.edges() > MAX_ROUTE_EDGES
                || !route.from().equals(player.getBlockPos()) || route.from().equals(route.endpoint())
                || route.from().equals(route.next()) || route.from().getY() != route.endpoint().getY()
                || route.from().getY() != route.next().getY()) {
            routeOffer = null;
            return;
        }
        if (routeOffer == null || routeOffer.route != route) {
            String id = "o-" + ++nextId;
            String steps = route.edges() == 1 ? "1 level edge" : route.edges() + " level edges";
            routeOffer = new Offer(id, new Key(Verb.FOLLOW, null, 0, id), "Follow a witnessed dry cave segment",
                steps + " with a distinct endpoint and a witnessed return. Recheck each edge before moving.",
                0, 0, null, null, null, null, null, route);
        }
        if (offers.size() < MAX_OFFERS) offers.add(routeOffer);
    }

    private Face face(BlockHitResult hit) {
        return new Face(hit, client.world.getBlockState(hit.getBlockPos()));
    }

    private void survey(List<Offer> offers, String id, float yaw, float pitch, String title, String evidence) {
        Key key = new Key(Verb.SURVEY, null, surveyOrigin, id);
        if (!retiredViews.contains(key) && angle(client.player.getYaw(), client.player.getPitch(), yaw, pitch) >= 7)
            offer(offers, key, title, evidence, yaw, pitch, null, null, null, null, null);
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
        String id = ids.get(key);
        if (id == null) {
            if (ids.size() >= 256) ids.pollFirstEntry();
            id = "o-" + ++nextId;
            ids.put(key, id);
        }
        offers.add(new Offer(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe));
    }

    private String materialTarget(Key key) {
        String target = materialTargets.get(key);
        if (target != null || materialTargets.size() >= MAX_MATERIAL_TARGETS) return target;
        target = "m-" + ++nextMaterialId;
        materialTargets.put(key, target);
        return target;
    }

    /** Describes only this primitive's possible spend, never a hidden or expected drop. */
    private JsonObject material(Offer offer, PlayerInventory inventory) {
        String subject, target;
        JsonObject spends;
        switch (offer.key.verb) {
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

    private void publish(AgentProgress progress) {
        publish(progress, 0);
    }

    private void publish(AgentProgress progress, float crack) {
        lastObservation = tick;
        JsonObject value = header(run);
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("epoch", epoch);
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
        if (progress != null && observableWorld()) {
            if (action == null) visible = offers(progress);
            else if (action.intent == null && action.keepVisible.length != 0) {
                var continuing = new ArrayList<Offer>(action.keepVisible.length);
                for (Offer anchor : action.keepVisible) if (liveMaterialFace(anchor, progress)) continuing.add(anchor);
                visible = continuing;
            }
        }
        for (Offer offer : visible) {
            JsonObject entry = new JsonObject();
            entry.addProperty("id", offer.id);
            entry.addProperty("verb", offer.key.verb.id);
            entry.addProperty("summary", offer.summary);
            entry.addProperty("evidence", offer.evidence);
            entry.addProperty("risk", offer.key.verb.risk);
            JsonObject material = material(offer, inv);
            if (material != null) entry.add("material", material);
            opportunities.add(entry);
            witnessed.put(offer.id, offer);
        }
        snapshots.put(tick, new Snapshot(epoch, witnessed.isEmpty() ? Map.of() : witnessed));
        while (!snapshots.isEmpty() && snapshots.firstEntry().getKey() < tick - MAX_AGE) snapshots.pollFirstEntry();
        value.add("opportunities", opportunities);
        JsonArray history = new JsonArray(recent.size());
        for (String event : recent) history.add(event);
        value.add("recent", history);
        value.addProperty("quiescent", quiescent);
        ipc.observation.set(value.toString());
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
        if (work.active()) {
            if (desired != null && workNearTarget(desired, observed, required)) replan = "target_near";
            else if (work.budget.nearLimit()) replan = "cap_near";
            else if (work.deadline - now <= 7_500_000_000L) replan = "expiry_near";
        }
        String description = work.enactedStatus;
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
        if (action == null) return;
        if (closeOwned) {
            if (action.craftJob != 0 && action.craftJob == hands.jobGeneration() && hands.busy()) hands.cancel();
            else if (action.opened != null && action.opened == client.currentScreen && cursorClear()) action.opened.close();
        }
        finish("interrupted", detail);
    }

    private void finish(String result, String detail) {
        if (action.offer.key.verb == Verb.BREAK && (owner.equals("terra") || action.durable)
                && !owner.equals("safety")) body.pauseWork();
        if (action.offer.route != null) {
            if (routeOwner != null) routeOwner.cancelFollowDryRoute(action.offer.route);
            routeOwner = null;
            routeOffer = null;
            if (!owner.equals("safety")) body.pauseWork();
        }
        String pickup = unexpectedPickup();
        if (pickup != null) {
            result = "interrupted";
            detail = pickup;
        }
        if ((action.offer.key.verb == Verb.SURVEY || action.offer.key.verb == Verb.INSPECT)
                && retiredViews.size() < 256) retiredViews.add(action.offer.key);
        if (action.durable) {
            remember("work " + action.offer.key.verb.id + " " + result + ": " + detail);
            if (!result.equals("completed") && !urgent) {
                enact("hold", detail);
                if (action.offer.face != null) {
                    BlockPos refused = action.offer.face.hit.getBlockPos();
                    if (action.offer.key.verb == Verb.WORK_PLACE) refused = refused.up();
                    work.rejected.add(refused);
                } else if (action.offer.drop != null) work.rejectedDrops.add(action.offer.drop.getId());
                if (action.offer.key.verb == Verb.CONTINUE)
                    retireWork("needs_replan", "interrupted", detail);
            } else if (result.equals("completed")) {
                if (action.offer.key.verb == Verb.BREAK || action.offer.key.verb == Verb.CONTINUE
                        || action.offer.key.verb == Verb.WORK_PLACE || action.offer.drop != null) {
                    work.lastEffect = detail;
                    work.lastEffectTick = tick;
                }
                enact("hold", detail);
                work.sweep = work.sweepWait = 0;
                work.sweepStart = player.getYaw();
            }
        } else if (action.intent == null) {
            remember("local_motion " + result + ": " + detail);
            if (result.equals("completed")) ++fallbackActions;
        } else receipt(action.intent, result, detail);
        if (result.equals("completed") && (!action.durable || continuityWork != null) && !action.purposefulMotion)
            purposeful(detail);
        action = null;
    }

    private String unexpectedPickup() {
        if (action == null || action.walkInventory == null || client.player != player || client.world != world) return null;
        if (action.unexpectedPickup != null) return action.unexpectedPickup;
        Item item = action.walkInventory.gain(player.getInventory());
        if (item != null) action.unexpectedPickup = "Unexpected inventory gain during " + action.offer.key.verb.id
            + ": " + Registries.ITEM.getId(item) + ".";
        return action.unexpectedPickup;
    }

    private String timeoutDetail() {
        return switch (action.offer.key.verb) {
            case BREAK -> "The resource did not produce a matching vanilla break event before expiry.";
            case APPROACH -> "The short walk did not settle on the witnessed tile before expiry.";
            case COLLECT -> "The drop did not produce a matching inventory gain before expiry.";
            case INTERACT -> "The workstation did not produce the expected rendered GUI before expiry.";
            case FOLLOW -> "The witnessed dry route did not settle at its authorized endpoint before expiry.";
            case CONTINUE -> "The trusted recipe did not produce a matching vanilla crafting receipt before expiry.";
            case SURVEY, INSPECT -> "The camera did not render the intended pose before expiry.";
            case WORK_WALK -> "The route did not reach its witnessed target before expiry.";
            case WORK_EQUIP -> "The work equipment did not settle before expiry.";
            case WORK_PLACE -> "The authorized placement did not settle before expiry.";
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
        recent.addLast(event);
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
    private static final class Ipc {
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
