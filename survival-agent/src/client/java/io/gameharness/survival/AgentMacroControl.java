package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.FurnaceScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.player.PlayerInventory;
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
import net.minecraft.world.GameMode;

/** Camera witnesses and short, cancellable vanilla actions. The host sends IDs, never input or source. */
final class AgentMacroControl {
    private static final int OBSERVATION_INTERVAL = 5;
    private static final long PLANNING_IDLE_LIMIT_NS = 3_000_000_000L;
    // Leave time for a bounded probe and rendered camera motion, not just a turn command.
    private static final long CAMERA_DISPATCH_LEAD_NS = 600_000_000L;
    private static final int MAX_AGE = 1_200;
    private static final int MAX_HANDOFF_AGE = 100;
    private static final int MAX_OFFERS = 16;
    private static final int APPROACH_SETTLE_TICKS = 3;
    private static final double INSPECT_REACH = 16;
    private static final double SETTLED_SPEED_SQUARED = 0.001225;
    private static final Direction[] CARDINAL = {Direction.SOUTH, Direction.WEST, Direction.NORTH, Direction.EAST};
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
        CONTINUE("continue", "guarded", 320);

        final String id, risk;
        final int maxTicks;
        Verb(String id, String risk, int maxTicks) {
            this.id = id; this.risk = risk; this.maxTicks = maxTicks;
        }
    }

    /** All world geometry and entity identities stay private to the native thread. */
    private record Floor(BlockPos pos, BlockState state, Vec3d landing) {}
    private record Face(BlockHitResult hit, BlockState state) {}
    private record Key(Verb verb, BlockPos pos, int entity, String activity) {}
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
                         Floor floor, Face face, ItemEntity drop, Item item, Recipe recipe) {}
    private record Snapshot(long epoch, Map<String, Offer> offers) {}
    private record Intent(String id, int life, long epoch, long basis, long expires, String opportunity, String skillHash) {}
    private record Handoff(int life, long epoch, long basis, long expires) {}
    private record Planning(int life, long epoch, long basis, String id, long noticedAt) {}
    private record Inbox(boolean active, Intent intent, Handoff handoff, Planning planning) {}
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
        boolean drove, fired, broken, purposefulMotion;
        long firedAt, pickupDisappeared, craftJob, priorCraftReceipt, settledAt;
        String unexpectedPickup;
        Screen opened;

        Action(Intent intent, Offer offer, MinecraftClient client, long tick, long now, long frame, int itemCount) {
            this.intent = intent;
            this.offer = offer;
            started = tick;
            startedAt = now;
            startingFrame = frame;
            position = client.player.getPos();
            yaw = client.player.getYaw();
            pitch = client.player.getPitch();
            this.itemCount = itemCount;
            walkInventory = offer.key.verb == Verb.APPROACH ? new InventoryWitness(client.player.getInventory()) : null;
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

    private final String run, goal;
    private final Ipc ipc;
    private final boolean activated, trial;
    private final LinkedHashMap<Long, Snapshot> snapshots = new LinkedHashMap<>();
    private final LinkedHashMap<Key, String> ids = new LinkedHashMap<>();
    private final LinkedHashMap<String, Boolean> consumed = new LinkedHashMap<>();
    private final Set<Key> retiredViews = new HashSet<>();
    private final Set<BlockPos> localSteps = new HashSet<>();
    private final ArrayDeque<String> recent = new ArrayDeque<>(8);
    private MinecraftClient client;
    private AgentBody body;
    private AgentHands hands;
    private Screen shown;
    private ClientWorld world;
    private ClientPlayerEntity player;
    private Vec3d anchor;
    private float surveyYaw;
    private long tick, epoch, nextId, lastObservation, inventoryStamp;
    private long fallbackTicks;
    private long fallbackActions, blockedCount, urgentCount, lastPurposefulTick;
    private long now, idleSince, waitElapsed, waitTotal, waitMaximum, waitOvershoot, nextLocalProbe;
    private long rawNoWorkSince, rawNoWorkMax, planningNoticeTick, planningNoticeNanos;
    private int life, surveyOrigin;
    private Inbox input;
    private Action action;
    private boolean suspended, visited, owned, hazardClear, lastHazard, quiescent, urgent, blocked, deadlineMeasured;
    private boolean urgentInput;
    private boolean rawPending;
    private String planningState = "awaiting_plan", planningEvidence = "No provider decision is pending.";
    private String activePlanningId, lastPurposefulAction, lastUrgency, blockedReason;
    private boolean trialUsed, revocationSeen, revocationAcknowledged;
    private String owner = "deterministic";
    private String status = "waiting for a current local plan";

    static AgentMacroControl create(Path directory, String goal) {
        Path macro = directory.resolve("macro");
        String run = directory.getFileName().toString();
        // Startup-only admission. Inactive deterministic runs allocate no channel or thread.
        if (!TOKEN.matcher(run).matches()) return null;
        boolean trial = Ipc.marked(macro, run, "trial.json");
        boolean active = Ipc.marked(macro, run, "active.json");
        return trial || active ? new AgentMacroControl(macro, run, goal, active, trial) : null;
    }

    private AgentMacroControl(Path directory, String run, String goal, boolean active, boolean trial) {
        this.run = run;
        this.goal = goal;
        this.activated = active;
        this.trial = trial;
        ipc = new Ipc(directory, run, active);
    }

    void begin(MinecraftClient client, AgentBody body, AgentHands hands, Screen shown, long tick, int life) {
        if (owned && this.body == body) body.pauseWork();
        suspended = owned = visited = hazardClear = false;
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.shown = shown;
        this.tick = tick;
        sampleClock();
        input = ipc.inbox;
        owner = engaged() ? "safety" : "deterministic";
        if (this.life != life || world != client.world || player != client.player) {
            interrupt("The player life or dimension changed.", false);
            this.life = life;
            world = client.world;
            player = client.player;
            ++epoch;
            snapshots.clear();
            ids.clear();
            recent.clear();
            anchor = null;
            inventoryStamp = 0;
            lastHazard = false;
            localSteps.clear();
            activePlanningId = null;
            idleSince = now;
            nextLocalProbe = 0;
            blocked = deadlineMeasured = false;
            waitElapsed = 0;
            rawPending = false;
        }
        observePlanning();
    }

    boolean engaged() { return input != null && (trial || activated); }
    boolean hasAction() { return action != null; }
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
        if (rawPending) rawNoWorkMax = Math.max(rawNoWorkMax, sample - rawNoWorkSince);
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
            }
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
        interrupt("Immediate safety took control: " + detail, true);
        if (!urgent) {
            ++urgentCount;
            remember("safety: " + detail);
        }
        urgent = true;
        lastUrgency = detail;
        state("urgent", detail);
    }

    void safetyEffect(String detail) {
        if (!engaged()) return;
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
            if (hands.busy()) hands.cancel();
            status = "macro authority is inactive";
            state("inactive", status);
            return;
        }
        sampleClock();
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
            idle(progress, thinking);
            return;
        }
        Offer offer = snapshots.get(intent.basis).offers.get(intent.opportunity);
        String refusal = !available() ? "No neutral, grounded, safe first-person view." :
            trial && (trialUsed || !diagnosticVerb(offer.key.verb)) ? "The diagnostic admits one isolated reader action."
            : !trial && intent.skillHash != null && offer.key.verb == Verb.APPROACH
                ? "Reusable skills cannot approach while incidental pickup remains possible."
            : validate(offer, progress);
        if (refusal != null) {
            refuseUnseen(refusal);
            idle(progress, thinking);
            return;
        }
        markConsumed(intent.id);
        owner = "terra";
        action = new Action(intent, offer, client, tick, now, body.renderedFrame(),
            offer.item == null ? 0 : count(offer.item));
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
        body.pauseWork();
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
                Offer next = localOffer(progress, cameraReady);
                if (next == null) {
                    if (due) {
                        block("No new lit resource view or safe adjacent step toward a witnessed feature.");
                        return;
                    }
                } else {
                    if (next.floor != null) localSteps.add(next.floor.pos);
                    claim("local_motion");
                    ++fallbackTicks;
                    action = new Action(null, next, client, tick, now, body.renderedFrame(), 0);
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

    private Offer localOffer(AgentProgress progress, boolean allowCamera) {
        Offer inspect = null, survey = null, step = null;
        Vec3d from = client.player.getPos();
        BlockHitResult feature = body.find(AgentMacroControl::resource, INSPECT_REACH).orElse(null);
        double improvement = 0.5;
        if (localSteps.size() < 32) localSteps.add(client.player.getBlockPos().down());
        for (Offer offer : offers(progress)) {
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
        return step != null ? step : inspect != null ? inspect : survey;
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
            case BREAK -> visible(offer.face) && canBreak(offer.face, progress)
                ? null : "The resource, harvest tool, or safe reach changed.";
            case INTERACT -> visible(offer.face) && useAvailable() ? null : "The workstation or use control changed.";
            case CONTINUE -> ingredients(offer.recipe) && (offer.face == null
                ? !client.options.inventoryKey.isUnbound() : visible(offer.face) && useAvailable())
                ? null : "The recipe ingredients, storage, or workstation changed.";
        };
    }

    private void step(AgentProgress progress) {
        Offer offer = action.offer;
        status = offer.summary;
        if (client.currentScreen != null && offer.key.verb != Verb.INTERACT && offer.key.verb != Verb.CONTINUE) {
            interrupt("A different screen replaced the camera view.", false);
            return;
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
                if (horizontalSquared(action.position, client.player.getPos()) > 0.0144 || !visible(offer.face, INSPECT_REACH))
                    interrupt("The inspected face left the stationary lit camera view.", true);
                else if (body.renderedFrame() > action.startingFrame
                        && body.renderedDirection(action.camera.yaw, action.camera.pitch, 4)
                        && body.renderedAim(offer.face.hit.getPos(), 4)
                        && angle(action.yaw, action.pitch, client.player.getYaw(), client.player.getPitch()) >= 4)
                    complete("The first-person camera centered the witnessed face.");
                else body.turnFine(action.camera.yaw, action.camera.pitch);
            }
            case APPROACH, COLLECT -> walk(offer);
            case BREAK -> {
                if (action.broken) complete("Vanilla reported this player's break of the witnessed " + blockName(offer.face) + ".");
                else if (!visible(offer.face) || !canBreak(offer.face, progress))
                    interrupt("The resource face, selected harvest tool, or reach changed.", true);
                else if (body.mine(offer.face.hit)) action.fired = true;
            }
            case INTERACT, CONTINUE -> useOrCraft(offer);
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
                if (settled()) complete("The witnessed drop disappeared and the matching inventory count increased.");
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
        float yaw = heading(floor.landing.x - position.x, floor.landing.z - position.z);
        float pitch = MathHelper.clamp(action.pitch, 12, 42);
        body.macroFlatWalk(floor.landing, yaw, pitch);
    }

    private void useOrCraft(Offer offer) {
        if (action.craftJob != 0) {
            if (hands.jobGeneration() != action.craftJob) {
                interrupt("The trusted hand job was replaced.", false);
                return;
            }
            if (hands.busy()) {
                hands.tick();
                return;
            }
            var result = hands.lastCraftReceipt();
            if (result != null && result.sequence() > action.priorCraftReceipt
                    && result.recipe().equals(offer.recipe.id) && result.items() > 0 && client.currentScreen == null) {
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
        if (!cursorClear() || !ingredients(offer.recipe) || !hands.craft(offer.recipe.id)) {
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
                && action.offer.face.hit.getBlockPos().equals(pos) && action.offer.face.state == state) action.broken = true;
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
            if (activated && !revocationSeen) {
                revocationSeen = true;
                quiescent = false;
                ++epoch;
                publish(null);
            }
            if (action != null) interrupt(safety, true);
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
        }
        if (action != null && (action.offer.key.verb == Verb.APPROACH || action.offer.key.verb == Verb.COLLECT))
            action.drove |= client.options.forwardKey.isPressed();
        boolean due = tick - lastObservation >= OBSERVATION_INTERVAL || lastObservation == 0;
        updateScope(due);
        // Ordinary local work may continue on the very next tick. Only an observed
        // promotion barrier (or an isolated trial) advertises a held neutral window.
        quiescent = (trial || handoffCurrent(input.handoff)) && visited && owned && available();
        if (due) publish(progress);
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
        if (client != null && player != null && client.player == player && client.world == world
                && life != 0 && ipc.inbox.active) {
            ++epoch;
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
        return visited && action == null && grounded() && hazardClear && cursorClear() && client.currentScreen == null
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
        }
        // A currently owned recipe or pickup can change inventory as part of its effect.
        if (action == null && checkInventory) {
            var inventory = client.player.getInventory();
            long stamp = 1;
            for (int i = 0; i < inventory.size(); i++) {
                ItemStack stack = inventory.getStack(i);
                if (!stack.isEmpty()) stamp = stamp * 31 + System.identityHashCode(stack.getItem()) * 17L + stack.getCount() + i;
            }
            if (stamp != inventoryStamp) {
                inventoryStamp = stamp;
                ++epoch;
            }
        }
    }

    private List<Offer> offers(AgentProgress progress) {
        var offers = new ArrayList<Offer>(MAX_OFFERS);
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
            if (useAvailable()) {
                offer(offers, new Key(Verb.INTERACT, station.getBlockPos(), 0, null),
                    "Open visible " + blockName(face), "A lit workstation face is inside vanilla use reach.",
                    0, pitch, null, face, null, null, null);
                if (face.state.isOf(Blocks.CRAFTING_TABLE)) for (Recipe recipe : BENCH_RECIPES) craftOffer(offers, recipe, face);
            }
        }
        var resource = body.find(AgentMacroControl::resource, reach(),
            hit -> canBreak(hit.getBlockPos(), client.world.getBlockState(hit.getBlockPos()), progress)).orElse(null);
        if (resource != null) {
            Face face = face(resource);
            offer(offers, new Key(Verb.BREAK, resource.getBlockPos(), 0, null),
                "Break visible " + blockName(face), "A lit resource face is in reach and the selected hand can harvest it.",
                0, pitch, null, face, null, null, null);
        }
        var resourceView = body.find(AgentMacroControl::resource, INSPECT_REACH, hit ->
            !retiredViews.contains(new Key(Verb.INSPECT, hit.getBlockPos(), 0, null)) && !body.renderedAim(hit.getPos(), 7))
            .orElse(null);
        if (resourceView != null) inspect(offers, face(resourceView));
        if (!client.options.inventoryKey.isUnbound()) {
            craftOffer(offers, PLANKS, null);
            craftOffer(offers, STICKS, null);
            craftOffer(offers, BENCH, null);
        }
        return offers;
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
        Key key = new Key(Verb.INSPECT, face.hit.getBlockPos(), 0, null);
        if (!retiredViews.contains(key) && !body.renderedAim(face.hit.getPos(), 7))
            offer(offers, key, "Center the visible " + blockName(face), "A lit face is visible away from the current crosshair.",
                0, 0, null, face, null, null, null);
    }

    private void craftOffer(List<Offer> offers, Recipe recipe, Face face) {
        if (ingredients(recipe) && (recipe.result == null || count(recipe.result) == 0 || recipe == STICKS)) {
            offer(offers, new Key(Verb.CONTINUE, face == null ? null : face.hit.getBlockPos(), 0, recipe.id),
                "Craft " + recipe.id + (face == null ? " in the inventory grid" : " at the visible crafting table"),
                "The visible inventory holds the ingredients for this vanilla recipe" + (face == null ? "." : "; the table is in reach."),
                0, 0, null, face, null, null, recipe);
        }
    }

    private void offer(List<Offer> offers, Key key, String summary, String evidence, float yaw, float pitch, Floor floor,
                       Face face, ItemEntity drop, Item item, Recipe recipe) {
        if (offers.size() == MAX_OFFERS) return;
        String id = ids.get(key);
        if (id == null) {
            if (ids.size() >= 256) ids.pollFirstEntry();
            id = "o-" + ++nextId;
            ids.put(key, id);
        }
        offers.add(new Offer(id, key, summary, evidence, yaw, pitch, floor, face, drop, item, recipe));
    }

    private void publish(AgentProgress progress) {
        lastObservation = tick;
        JsonObject value = header(run);
        value.addProperty("life", life);
        value.addProperty("tick", tick);
        value.addProperty("epoch", epoch);
        value.addProperty("goal", goal);
        value.addProperty("health", client.player.getHealth());
        value.addProperty("food", client.player.getHungerManager().getFoodLevel());
        JsonObject inventory = new JsonObject();
        var inv = client.player.getInventory();
        for (int i = 0; i < inv.size(); i++) {
            ItemStack stack = inv.getStack(i);
            if (stack.isEmpty()) continue;
            String id = Registries.ITEM.getId(stack.getItem()).toString();
            inventory.addProperty(id, stack.getCount() + (inventory.has(id) ? inventory.get(id).getAsInt() : 0));
        }
        value.add("inventory", inventory);
        JsonArray opportunities = new JsonArray();
        Map<String, Offer> witnessed = new LinkedHashMap<>();
        if (progress != null && observable()) for (Offer offer : offers(progress)) {
            JsonObject entry = new JsonObject();
            entry.addProperty("id", offer.id);
            entry.addProperty("verb", offer.key.verb.id);
            entry.addProperty("summary", offer.summary);
            entry.addProperty("evidence", offer.evidence);
            entry.addProperty("risk", offer.key.verb.risk);
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
        String pickup = unexpectedPickup();
        if (pickup != null) {
            result = "interrupted";
            detail = pickup;
        }
        if ((action.offer.key.verb == Verb.SURVEY || action.offer.key.verb == Verb.INSPECT)
                && retiredViews.size() < 256) retiredViews.add(action.offer.key);
        if (action.intent == null) {
            remember("local_motion " + result + ": " + detail);
            if (result.equals("completed")) ++fallbackActions;
        } else receipt(action.intent, result, detail);
        if (result.equals("completed") && !action.purposefulMotion) purposeful(detail);
        action = null;
    }

    private String unexpectedPickup() {
        if (action == null || action.walkInventory == null || client.player != player || client.world != world) return null;
        if (action.unexpectedPickup != null) return action.unexpectedPickup;
        Item item = action.walkInventory.gain(player.getInventory());
        if (item != null) action.unexpectedPickup = "Unexpected inventory gain during approach: " + Registries.ITEM.getId(item) + ".";
        return action.unexpectedPickup;
    }

    private String timeoutDetail() {
        return switch (action.offer.key.verb) {
            case BREAK -> "The resource did not produce a matching vanilla break event before expiry.";
            case APPROACH -> "The short walk did not settle on the witnessed tile before expiry.";
            case COLLECT -> "The drop did not produce a matching inventory gain before expiry.";
            case INTERACT -> "The workstation did not produce the expected rendered GUI before expiry.";
            case CONTINUE -> "The trusted recipe did not produce a matching vanilla crafting receipt before expiry.";
            case SURVEY, INSPECT -> "The camera did not render the intended pose before expiry.";
        };
    }

    private void receipt(Intent intent, String result, String detail) {
        JsonObject value = header(run);
        value.addProperty("id", intent.id);
        value.addProperty("life", intent.life);
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
        private static final Set<String> INTENT_FIELDS =
            Set.of("v", "id", "run", "life", "epoch", "basisTick", "expiresTick", "opportunityId", "skillHash");
        private static final Set<String> HANDOFF_FIELDS = Set.of("v", "run", "life", "epoch", "basisTick", "expiresTick");
        private static final Set<String> PLANNING_FIELDS = Set.of("v", "run", "life", "epoch", "basisTick", "id");
        private static final Inbox OFF = new Inbox(false, null, null, null);
        private final Path directory;
        private final String run;
        private final ScheduledExecutorService worker;
        private final ScheduledFuture<?> poll;
        private final AtomicReference<String> observation = new AtomicReference<>();
        private final ArrayBlockingQueue<Output> evidence = new ArrayBlockingQueue<>(32);
        private volatile Inbox inbox;
        private volatile boolean retired, markerRevoked;

        Ipc(Path directory, String run, boolean active) {
            this.directory = directory;
            this.run = run;
            retired = !active;
            inbox = active ? new Inbox(true, null, null, null) : OFF;
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
                if (!markerRevoked && !marked(directory, run, "active.json")) {
                    markerRevoked = true;
                    retired = true;
                }
                Inbox next = retired ? OFF : new Inbox(true, readIntent(), readHandoff(), readPlanning(inbox.planning));
                inbox = retired ? OFF : next;
                flush();
            } catch (RuntimeException e) {
                retired = true;
                inbox = OFF;
            }
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
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return null;
            try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
                byte[] data = stream.readNBytes(limit + 1);
                if (data.length > limit) return null;
                var parsed = JsonParser.parseString(new String(data, StandardCharsets.UTF_8));
                return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
            } catch (IOException | RuntimeException e) {
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
