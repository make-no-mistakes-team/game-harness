package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import io.gameharness.survival.mixin.AgentHandledScreenAccess;
import io.gameharness.survival.mixin.AgentMiningAccess;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientChunkEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.event.client.player.ClientPlayerBlockBreakEvents;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.screen.AbstractCraftingScreenHandler;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.GameMode;
import net.minecraft.world.chunk.WorldChunk;

/** Private run telemetry observes the player. No command, server or world-data input channel. */
public final class AgentClient implements ClientModInitializer {
    private static final long CONTROL_TIMEOUT = 15_000_000_000L;
    private static final long RESPAWN_TIMEOUT = 30_000_000_000L;
    private static final Set<PosixFilePermission> PRIVATE_STOP_MODE =
        Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);

    private enum LifePhase {
        PLAYING("playing"), DEATH_SCREEN("death_screen"), RESPAWN_REQUESTED("respawn_requested");

        private final String id;
        LifePhase(String id) { this.id = id; }
    }

    private static AgentClient active;
    private Path directory;
    private Path runnerStopMarker;
    private String goal;
    private ClientPlayNetworkHandler network;
    private AgentHands hands;
    private AgentBody body;
    private AgentProgress progress;
    private AgentEars ears;
    private AgentMacroControl macro;
    private AgentPendingFurnaceMemory pendingFurnaceMemory;
    private AgentPauseEpisodes pauses;
    private ClientPlayerEntity continuityPlayer;
    private BlockPos continuityMine;
    private Vec3d continuityLanding;
    private final Vec3d[] recentContinuityLandings = new Vec3d[16];
    private float continuityCrack, continuityYaw, continuityPitch;
    private double continuityX, continuityY, continuityZ, continuityRouteStart, continuityRouteBest;
    private long continuityGui;
    private int continuityRouteSteps, continuityLandingCursor;
    private boolean continuityBreak, revisitingContinuityLanding, creditedContinuityLanding;
    private long tick;
    private String lastStatus = "";
    private String lastHands = "";
    private String lastOwner = "deterministic";
    private boolean lastTouchingWater;
    private String lastPlanningState = "";
    private String lastPlanningEvidence = "";
    private long lastPurposefulTick;
    private Screen renderedScreen;
    private int personalOpens;
    private int benchOpens;
    private boolean screenChanged;
    private float lastYaw = Float.NaN;
    private float lastPitch = Float.NaN;
    private double yawTravel;
    private double pitchTravel;
    private int sprintTicks;
    private int rockBroken;
    private BufferedWriter movement;
    private BufferedWriter contacts;
    private BufferedWriter looks;
    private final long lookSeed = ThreadLocalRandom.current().nextLong();
    private long craftSequence;
    private int returnableDropSequence;
    private long stallSequence;
    private int horizonEvidenceCount, wadeEvidenceCount;
    private boolean allowRespawn;
    private boolean initialDeathScreen;
    private LifePhase lifePhase = LifePhase.PLAYING;
    private int deaths, respawns;
    private ClientPlayerEntity deadPlayer;
    private AgentRespawn respawn;
    private long lifeDeadline;
    private long lastFuseCheckNs, lastFuseCheckTick, fuseTick;
    private Vec3d fuseOrigin;
    private Item fuseCursorItem;
    private long priorShiftPresses;
    private int priorStallIncidents, priorStallAttempts, priorStallRecoveries, priorStallFailures;
    private int priorShortJumps, priorHeadroomCleared, priorHeadroomBypasses;
    private int priorCaveOpenings, priorCaveSteps;
    private int priorWaterAttempts, priorWaterLandings, priorBoatAttempts, priorBoatLandings;
    private int priorMeals, priorFoodPickedUp;
    private boolean ended, stoppingForRunner;
    private boolean ownedSinglePlayer;

    private static JsonArray coordinates(Set<BlockPos> cells) {
        JsonArray result = new JsonArray(cells.size());
        for (BlockPos pos : cells) {
            JsonArray xyz = new JsonArray(3);
            xyz.add(pos.getX());
            xyz.add(pos.getY());
            xyz.add(pos.getZ());
            result.add(xyz);
        }
        return result;
    }

    private static JsonArray coordinates(BlockPos pos) {
        JsonArray xyz = new JsonArray(3);
        xyz.add(pos.getX());
        xyz.add(pos.getY());
        xyz.add(pos.getZ());
        return xyz;
    }

    @Override public void onInitializeClient() {
        String output = System.getProperty("gh.agent.dir", System.getenv("GH_AGENT_DIR"));
        goal = System.getProperty("gh.agent.goal", System.getenv("GH_AGENT_GOAL"));
        if (output == null && goal == null) return;
        if (output == null || goal == null || !Set.of("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal").contains(goal))
            throw new IllegalArgumentException("Expected an agent directory and supported survival goal");
        directory = Path.of(output).toAbsolutePath();
        if (!Files.isDirectory(directory)) throw new IllegalStateException("Missing private agent directory");
        runnerStopMarker = directory.resolve("runner-stop-" + directory.getFileName());
        allowRespawn = Files.isRegularFile(directory.resolve("allow-vanilla-respawn"), LinkOption.NOFOLLOW_LINKS);
        active = this;
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            if (hands != null) hands.discardLifeInputs();
            stopMacro("actor_exit", "The client is stopping.");
            if (macro != null) macro.drain();
            if (progress != null) progress.saveMemory(true);
            detachEars(client);
            closeMovement();
        });
        ClientTickEvents.START_CLIENT_TICK.register(this::drive);
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            if (macro != null) {
                macro.clearUnconsumedWaterUse();
                macro.clearUnconsumedFurnaceUse();
            }
        });
        ClientChunkEvents.CHUNK_LOAD.register(this::observeFurnaceChunk);
        ClientChunkEvents.CHUNK_UNLOAD.register(this::observeFurnaceChunk);
        ScreenEvents.AFTER_INIT.register((client, screen, width, height) -> {
            if (screen instanceof DeathScreen deathScreen) {
                ScreenEvents.afterRender(screen).register((shown, context, mouseX, mouseY, tickDelta) ->
                    renderDeathScreen(client, deathScreen, mouseX, mouseY));
            }
        });
        WorldRenderEvents.START.register(context -> {
            if (playing(MinecraftClient.getInstance())) body.observeFrame(context);
        });
        ClientPlayerBlockBreakEvents.AFTER.register((world, player, pos, state) -> {
            MinecraftClient client = MinecraftClient.getInstance();
            if (!playing(client) || player != client.player) return;
            progress.observeOwnBreak(pos, state);
            if (macro != null) macro.ownBreak(pos, state);
            if (pauses != null && pos.equals(continuityMine)) continuityBreak = true;
            if (state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE) || state.isOf(Blocks.TUFF) ||
                state.isOf(Blocks.GRANITE) || state.isOf(Blocks.DIORITE) || state.isOf(Blocks.ANDESITE)) ++rockBroken;
            JsonObject hit = new JsonObject();
            hit.addProperty("tick", tick);
            hit.addProperty("wall_ms", System.currentTimeMillis());
            hit.addProperty("block", Registries.BLOCK.getId(state.getBlock()).toString());
            hit.addProperty("held", Registries.ITEM.getId(player.getMainHandStack().getItem()).toString());
            append("breaks.jsonl", hit + "\n");
        });
    }

    private void append(String file, String line) {
        try { Files.writeString(directory.resolve(file), line, StandardOpenOption.CREATE, StandardOpenOption.APPEND); }
        catch (IOException e) { body.release(); ended = true; throw new UncheckedIOException(e); }
    }

    private void recordHorizon(AgentVisibleHorizon.Evidence evidence) {
        if (evidence == null) return;
        if (evidence.phase().equals("wade")) {
            if (wadeEvidenceCount >= 32) return;
            ++wadeEvidenceCount;
        } else {
            if (horizonEvidenceCount >= 64) return;
            ++horizonEvidenceCount;
        }
        var event = new JsonObject();
        event.addProperty("tick", tick);
        event.addProperty("life", 1 + respawns);
        event.addProperty("frame", evidence.frame());
        event.addProperty("phase", evidence.phase());
        event.addProperty("stage", evidence.stage());
        if (evidence.terminal()) event.addProperty("terminal", true);
        if (Double.isFinite(evidence.known())) event.addProperty("offered_ground", evidence.known());
        if (Double.isFinite(evidence.braking())) event.addProperty("braking_distance", evidence.braking());
        if (evidence.refusals() != 0) {
            var failed = new JsonArray();
            for (var refusal : AgentVisibleHorizon.Refusal.values())
                if ((evidence.refusals() & refusal.bit) != 0) failed.add(refusal.key);
            event.add("rejected_checks", failed);
        }
        // Local run journal only: never attach these reasons to progress or macro observations.
        append("horizon.jsonl", event + "\n");
    }

    private void recordMovement(MinecraftClient client, ClientPlayerEntity p, String activity) {
        // Sample the actual player, not the commanded angles or requested sprint key.
        if (p == null) return;
        try {
            if (movement == null) {
                movement = Files.newBufferedWriter(directory.resolve("movement.tsv"), StandardOpenOption.CREATE_NEW);
                movement.write("tick\twall_ms\tx\ty\tz\tyaw\tpitch\tgrounded\tsprinting\tfood\tgui\tactivity\n");
            }
            movement.write(tick + "\t" + System.currentTimeMillis() + "\t" + p.getX() + "\t" + p.getY() + "\t" +
                p.getZ() + "\t" + p.getYaw() + "\t" + p.getPitch() + "\t" + p.isOnGround() + "\t" +
                p.isSprinting() + "\t" + p.getHungerManager().getFoodLevel() + "\t" + (client.currentScreen != null) +
                "\t" + activity + "\n");
            if (tick % 20 == 0) {
                movement.flush();
                if (contacts != null) contacts.flush();
                if (looks != null) looks.flush();
            }
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    private void recordContact(AgentBody.ContactEvidence hit) {
        try {
            if (contacts == null) {
                contacts = Files.newBufferedWriter(directory.resolve("world-contacts.tsv"), StandardOpenOption.CREATE_NEW);
                contacts.write("tick\tlife\tframe\twall_ms\taction\tstatus\tx\ty\tz\tside\tu\tv\tdegrees_per_second\tdwell_ticks\tdwell_ms\n");
            }
            BlockPos pos = hit.pos();
            String location = pos == null ? "\t\t" : pos.getX() + "\t" + pos.getY() + "\t" + pos.getZ();
            contacts.write(tick + "\t" + (respawns + 1) + "\t" + hit.frame() + "\t" + hit.wallMs() + "\t" +
                hit.action() + "\t" + hit.status() + "\t" + location + "\t" + (hit.side() == null ? "" : hit.side().name()) +
                "\t" + finiteSample(hit.u()) + "\t" + finiteSample(hit.v()) + "\t" + finiteSample(hit.degreesPerSecond()) +
                "\t" + hit.dwellTicks() + "\t" + hit.dwellMs() + "\n");
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    public static boolean allowScopedWaterUse() {
        return active == null || active.macro == null || active.macro.allowScopedWaterUse();
    }

    public static void confirmScopedWaterUse() {
        if (active != null && active.macro != null) active.macro.confirmScopedWaterUse();
    }

    public static boolean allowScopedFurnaceUse() {
        return active == null || active.macro == null || active.macro.allowScopedFurnaceUse();
    }

    public static void confirmScopedFurnaceUse(ClientPlayerEntity player, BlockHitResult hit) {
        if (active != null && active.macro != null) active.macro.confirmScopedFurnaceUse(player, hit);
    }

    public static void observeFurnaceBlock(ClientWorld world, BlockPos pos, BlockState state) {
        if (active != null && active.macro != null) active.macro.observeFurnaceBlock(world, pos, state);
    }

    private void observeFurnaceChunk(ClientWorld world, WorldChunk chunk) {
        if (macro != null) macro.observeFurnaceChunk(world, chunk.getPos());
    }

    static boolean ownsSinglePlayerFurnaceWorld(MinecraftClient client, ClientPlayerEntity player) {
        return active != null && active.playing(client) && active.soleFurnaceActor(client, player);
    }

    private boolean soleFurnaceActor(MinecraftClient client, ClientPlayerEntity player) {
        if (!ownedSinglePlayer || !sameConnection(client) || player == null || !player.isAlive()
                || client.world == null || player.getWorld() != client.world || client.player != player
                || !survival(client) || player.networkHandler.getPlayerList().size() != 1
                || player.networkHandler.getPlayerListEntry(player.getUuid()) == null) return false;
        for (var other : client.world.getPlayers()) if (other != player) return false;
        return true;
    }

    private static String finiteSample(double value) {
        return Double.isFinite(value) ? Double.toString(value) : "";
    }

    private void recordLook(AgentBody.LookEvidence look) {
        try {
            if (looks == null) {
                looks = Files.newBufferedWriter(directory.resolve("world-looks.tsv"), StandardOpenOption.CREATE_NEW);
                looks.write("life\tend_tick\twall_ms\tseed\tsequence\tcontext\tprofile\teffort\tinitial_degrees\tapplied_degrees\tpeak_deg_s\tpeak_at_ms\tduration_ms\toutcome\n");
            }
            looks.write((respawns + 1) + "\t" + look.tick() + "\t" + look.wallMs() + "\t" + look.seed() + "\t" +
                look.sequence() + "\t" + look.context() + "\t" + look.profile() + "\t" + finiteSample(look.effort()) +
                "\t" + finiteSample(look.distance()) + "\t" + finiteSample(look.appliedDegrees()) + "\t" +
                finiteSample(look.peakDegreesPerSecond()) + "\t" + look.peakAtMs() + "\t" + look.durationMs() +
                "\t" + look.outcome() + "\n");
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    private void closeMovement() {
        if (body != null) body.finishWorldLook();
        try (BufferedWriter positions = movement; BufferedWriter actions = contacts; BufferedWriter gestures = looks) { }
        catch (IOException e) { throw new UncheckedIOException(e); }
        finally { movement = contacts = looks = null; }
    }

    public static void steerFrame() {
        if (active != null && active.progress != null && !active.ended) {
            MinecraftClient client = MinecraftClient.getInstance();
            Screen shown = client.currentScreen;
            active.observeScreen(shown);
            if (active.observeDeath(client) || !active.playing(client)) return;
            active.body.frame();
            active.hands.frame();
            var player = client.player;
            if (shown == null) {
                float yaw = player.getYaw();
                if (Float.isFinite(active.lastYaw)) active.yawTravel += Math.abs(MathHelper.wrapDegrees(yaw - active.lastYaw));
                float pitch = player.getPitch();
                if (Float.isFinite(active.lastPitch)) active.pitchTravel += Math.abs(pitch - active.lastPitch);
                active.lastYaw = yaw;
                active.lastPitch = pitch;
            } else active.lastYaw = active.lastPitch = Float.NaN;
        }
    }

    private void observeScreen(Screen shown) {
        if (shown == renderedScreen) return;
        renderedScreen = shown;
        screenChanged = true;
        if (shown instanceof InventoryScreen) ++personalOpens;
        else if (shown instanceof CraftingScreen) ++benchOpens;
    }

    private void renderDeathScreen(MinecraftClient client, DeathScreen screen, int mouseX, int mouseY) {
        if (ended || client.currentScreen != screen || (progress == null && !start(client))) return;
        observeScreen(screen);
        observeDeath(client);
        if (canPressRespawn(client)) respawn.rendered(screen, mouseX, mouseY, hands);
    }

    private static boolean survival(MinecraftClient client) {
        return client.interactionManager != null
            && client.interactionManager.getCurrentGameMode() == GameMode.SURVIVAL;
    }

    private boolean sameConnection(MinecraftClient client) {
        return network != null && network.getConnection().isOpen()
            && (client.player == null || client.player.networkHandler == network);
    }

    private boolean playing(MinecraftClient client) {
        return !ended && lifePhase == LifePhase.PLAYING && sameConnection(client) && client.player != null
            && client.player.isAlive() && client.world != null && client.player.getWorld() == client.world;
    }

    private boolean start(MinecraftClient client) {
        if (client.player == null || client.world == null || client.player.getWorld() != client.world
            || (client.currentScreen != null && !(client.currentScreen instanceof DeathScreen && client.player.isDead()))
            || !survival(client)) return false;
        var handler = client.getNetworkHandler();
        if (handler == null || !handler.getConnection().isOpen()
            || !(handler.getConnection().getAddress() instanceof InetSocketAddress peer)
            || peer.getAddress() == null || !peer.getAddress().isLoopbackAddress()) return false;
        ownedSinglePlayer = peer.getPort() == Integer.getInteger("gh.agent.ownedSinglePlayerPort", -1);
        network = handler;
        initialDeathScreen = client.currentScreen instanceof DeathScreen && client.player.isDead();
        pendingFurnaceMemory = new AgentPendingFurnaceMemory(directory);
        if (ownedSinglePlayer) pendingFurnaceMemory.bind(client.player.getUuid(), 1, tick, 0);
        macro = AgentMacroControl.create(directory, goal, pendingFurnaceMemory);
        bindPolicy(client);
        if (macro == null || !macro.trial()) pauses = new AgentPauseEpisodes(directory, tick);
        return true;
    }

    private void bindPolicy(MinecraftClient client) {
        body = new AgentBody(client, this::recordContact, this::recordLook, lookSeed + respawns);
        hands = new AgentHands(client);
        progress = new AgentProgress(client, body, hands, goal, new AgentMemory(directory));
        craftSequence = stallSequence = 0;
        returnableDropSequence = 0;
        lastFuseCheckNs = lastFuseCheckTick = fuseTick = 0;
        fuseOrigin = null;
        fuseCursorItem = null;
        if (client.player.isAlive()) {
            ears = new AgentEars(client, () -> renderedScreen);
            client.getSoundManager().registerListener(ears);
        }
    }

    private void detachEars(MinecraftClient client) {
        if (ears == null) return;
        client.getSoundManager().unregisterListener(ears);
        ears = null;
    }

    private void releaseLifeInputs(MinecraftClient client) {
        body.finishWorldLook();
        body.release();
        hands.discardLifeInputs();
        detachEars(client);
        lastYaw = lastPitch = Float.NaN;
    }

    private void stopMacro(String cause, String reason) {
        if (pauses != null) pauses.close(cause);
        if (macro == null) return;
        macro.suspend(tick, reason);
        macro.close(cause);
    }

    private boolean observeDeath(MinecraftClient client) {
        // Detached living entities can report !isAlive() on a world change; only zero health is death.
        if (lifePhase != LifePhase.PLAYING || !sameConnection(client)
            || client.player == null || !client.player.isDead()
            || (client.world != null && client.player.getWorld() != client.world)) return false;
        deadPlayer = client.player;
        observeContinuityIdle();
        if (tick == 0) tick = 1;
        pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
        if (macro != null) macro.suspend(tick, "The player died.");
        releaseLifeInputs(client);
        ++deaths;
        ended = !allowRespawn;
        transition(client, LifePhase.DEATH_SCREEN, "dead");
        progress.saveMemory(true);
        if (allowRespawn) {
            respawn = new AgentRespawn();
            lifeDeadline = System.nanoTime() + CONTROL_TIMEOUT;
        } else stopMacro("death_no_respawn", "No respawn is authorized.");
        return true;
    }

    private boolean canPressRespawn(MinecraftClient client) {
        return !ended && lifePhase == LifePhase.DEATH_SCREEN && respawn != null && sameConnection(client)
            && client.player == deadPlayer && deadPlayer.isDead()
            && client.world != null && deadPlayer.getWorld() == client.world && survival(client);
    }

    private void recoverLife(MinecraftClient client) {
        if (lifePhase == LifePhase.DEATH_SCREEN) {
            if (client.player != null && client.player != deadPlayer) {
                failLife(client, "Player changed before the agent requested respawn.");
            } else if (System.nanoTime() >= lifeDeadline) {
                failLife(client, "Vanilla Respawn control was not available.");
            } else if (canPressRespawn(client) && client.currentScreen instanceof DeathScreen deathScreen) {
                switch (respawn.press(deathScreen, hands)) {
                    case ACCEPTED -> {
                        respawn = null;
                        lifeDeadline = System.nanoTime() + RESPAWN_TIMEOUT;
                        transition(client, LifePhase.RESPAWN_REQUESTED, "waiting for vanilla respawn");
                        return;
                    }
                    case REJECTED -> failLife(client, "Vanilla did not accept the Respawn click.");
                    case NOT_READY -> { }
                }
            }
        } else if (replacementReady(client)) {
            accumulateLifeCounters();
            bindPolicy(client);
            ++respawns;
            if (ownedSinglePlayer) pendingFurnaceMemory.bind(client.player.getUuid(), 1 + respawns, tick, body.renderedFrame());
            deadPlayer = null;
            transition(client, LifePhase.PLAYING, "resumed Survival after respawn");
            progress.afterRespawn();
        } else if (System.nanoTime() >= lifeDeadline) {
            failLife(client, "Vanilla respawn did not return to a living Survival world.");
        }
        if (!ended && lifePhase != LifePhase.PLAYING)
            publish(client, lifePhase == LifePhase.DEATH_SCREEN ? "dead" : "waiting for vanilla respawn",
                false, null, false, 0);
    }

    private boolean replacementReady(MinecraftClient client) {
        var player = client.player;
        // Vanilla replaces the actor before its terrain screen closes. Do not credit that intermediate state.
        if (player == null || player == deadPlayer || !player.isAlive() || !player.getUuid().equals(deadPlayer.getUuid())
            || client.world == null || player.getWorld() != client.world || !survival(client)
            || client.currentScreen != null || client.getOverlay() != null || client.getCameraEntity() != player) return false;
        var chunk = player.getChunkPos();
        return client.world.isChunkLoaded(chunk.x, chunk.z);
    }

    private void accumulateLifeCounters() {
        var stall = progress.stallReport();
        priorStallIncidents += stall.incidents();
        priorStallAttempts += stall.attempts();
        priorStallRecoveries += stall.recoveries();
        priorStallFailures += stall.failures();
        var ceiling = body.headroomReport();
        priorShortJumps += ceiling.shortJumps();
        priorHeadroomCleared += ceiling.cleared();
        priorHeadroomBypasses += ceiling.bypasses();
        priorCaveOpenings += progress.caveOpenings();
        priorCaveSteps += progress.caveFootsteps();
        priorWaterAttempts += progress.fall().waterAttempts();
        priorWaterLandings += progress.fall().waterSuccesses();
        priorBoatAttempts += progress.fall().boatAttempts();
        priorBoatLandings += progress.fall().boatSuccesses();
        priorMeals += progress.mealsEaten();
        priorFoodPickedUp += progress.foodPickedUp();
        priorShiftPresses += hands.craftShiftClicks();
    }

    private ClientPlayerEntity admittedPlayer(MinecraftClient client) {
        var player = client.player;
        return player != null && player.networkHandler == network ? player : null;
    }

    private void lifeFields(JsonObject event, ClientPlayerEntity player) {
        event.addProperty("deaths", deaths);
        event.addProperty("respawns", respawns);
        event.addProperty("life", 1 + respawns);
        event.addProperty("life_phase", lifePhase.id);
        event.addProperty("alive", player != null && player.isAlive());
    }

    private void transition(MinecraftClient client, LifePhase next, String status) {
        lifePhase = next;
        long now = System.currentTimeMillis();
        JsonObject event = new JsonObject();
        event.addProperty("tick", tick);
        event.addProperty("wall_ms", now);
        event.addProperty("status", status);
        lifeFields(event, admittedPlayer(client));
        // This is admission evidence, not a claim about whether this world was copied.
        if (next == LifePhase.DEATH_SCREEN && deaths == 1 && tick == 1 && initialDeathScreen)
            event.addProperty("initial_death_screen", true);
        append("lives.jsonl", event + "\n");
        publish(client, status, false, null, true, now);
    }

    private void failLife(MinecraftClient client, String failure) {
        respawn = null;
        ended = true;
        stopMacro("respawn_failed", "Vanilla respawn failed.");
        publish(client, "respawn stopped", false, failure, true, System.currentTimeMillis());
    }

    private void drive(MinecraftClient client) {
        if (stoppingForRunner) return;
        if (runnerStopRequested()) {
            stopForRunner(client);
            return;
        }
        if (ended || (progress == null && !start(client))) return;
        if (tick == 0 && playing(client) && !progress.restoreMemory()) {
            observeContinuityIdle();
            return;
        }
        ++tick;
        if (!sameConnection(client)) {
            pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
            releaseLifeInputs(client);
            stopMacro("connection_closed", "The admitted loopback connection closed.");
            if (lifePhase != LifePhase.PLAYING) failLife(client, "Connection closed before respawn completed.");
            else { ended = true; closeMovement(); }
            return;
        }
        if (observeDeath(client)) return;
        if (lifePhase != LifePhase.PLAYING) {
            observeContinuityIdle();
            recoverLife(client);
            return;
        }
        if (!playing(client) || client.interactionManager == null) {
            // World changes sometimes clear the actor while the original connection stays open.
            observeContinuityIdle();
            pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
            if (macro != null) macro.suspend(tick, "The player left the current Survival view.");
            body.release();
            hands.discardLifeInputs();
            lastYaw = lastPitch = Float.NaN;
            return;
        }
        if (pendingFurnaceMemory.current() != null && !soleFurnaceActor(client, client.player))
            pendingFurnaceMemory.discontinuity(tick, body.renderedFrame());
        if (!progress.restoreMemory()) {
            observeContinuityIdle();
            return;
        }
        if (client.player.isSprinting()) ++sprintTicks;
        progress.observeMemoryFooting(tick);
        body.begin();
        if (macro != null) macro.begin(client, body, hands, renderedScreen, tick, 1 + respawns);
        long fuseCheckNs = System.nanoTime();
        var fuse = ears.takeFuseCue();
        var openAtCheck = fuse == null ? null : client.currentScreen;
        var shownAtCheck = fuse == null ? null : renderedScreen;
        String handsAtCheck = fuse == null ? null : hands.status();
        long handsGeneration = fuse == null ? 0 : hands.jobGeneration();
        var handler = fuse == null ? null : client.player.currentScreenHandler;
        var cursorAtCheck = handler == null ? null : handler.getCursorStack();
        Item cursorItem = cursorAtCheck == null || cursorAtCheck.isEmpty() ? null : cursorAtCheck.getItem();
        int cursorCount = cursorAtCheck == null ? 0 : cursorAtCheck.getCount();
        int cursorStock = cursorItem == null ? 0 : countItem(client.player.getInventory(), cursorItem) + cursorCount;
        if (cursorItem != null && handler instanceof AbstractCraftingScreenHandler crafting) {
            for (var slot : crafting.getInputSlots()) {
                var stack = slot.getStack();
                if (stack.isOf(cursorItem)) cursorStock += stack.getCount();
            }
        }
        int cursorPreviewSlots = openAtCheck instanceof CraftingScreen && openAtCheck instanceof AgentHandledScreenAccess access
            && access.agent$cursorDragging() ? access.agent$cursorDragSlots().size() : 0;
        String planningAtCheck = fuse == null || macro == null ? null : macro.planningState();
        long planningDeadlineNs = fuse == null || macro == null ? 0 : macro.planningIdleDeadlineNanos();
        boolean fleeing = ears.escape(body, hands);
        if (fleeing) body.interruptHorizonWade(AgentVisibleHorizon.Refusal.HAZARD);
        if (fleeing && macro != null) macro.urgent("evading a primed creeper");
        if (!fleeing) {
            if (macro == null || !macro.engaged()) hands.tick();
            progress.tick(ears, macro);
        }
        body.finish();
        if (fuse != null) {
            fuseOrigin = fuse.origin();
            fuseTick = tick;
            fuseCursorItem = cursorItem;
            JsonObject event = dangerEvent("fuse", client);
            soundFields(event, fuse);
            event.addProperty("previous_check_tick", lastFuseCheckTick);
            event.addProperty("previous_check_mono_ms", millis(lastFuseCheckNs));
            event.addProperty("check_mono_ms", millis(fuseCheckNs));
            event.addProperty("check_screen", screenKind(openAtCheck));
            event.addProperty("rendered_at_check", screenKind(shownAtCheck));
            event.addProperty("cue_screen_rendered_at_check", fuse.screen() != null && fuse.screen() == shownAtCheck);
            event.addProperty("screen_after_keys", screenKind(client.currentScreen));
            event.addProperty("hands_before", handsAtCheck);
            event.addProperty("hands_after", hands.status());
            event.addProperty("cursor_before_item", cursorItem == null ? "minecraft:air" : Registries.ITEM.getId(cursorItem).toString());
            event.addProperty("cursor_before_count", cursorCount);
            event.addProperty("cursor_after_count", client.player.currentScreenHandler.getCursorStack().getCount());
            event.addProperty("cursor_before_total", cursorStock);
            event.addProperty("cursor_preview_slots", cursorPreviewSlots);
            event.addProperty("gui_sync_id", handler.syncId);
            event.addProperty("hands_job_generation", handsGeneration);
            event.addProperty("pursued_fuse_escape", fleeing);
            event.addProperty("planning_before", planningAtCheck);
            event.addProperty("planning_deadline_mono_ms", millis(planningDeadlineNs));
            var keys = client.options;
            event.addProperty("key_forward", keys.forwardKey.isPressed());
            event.addProperty("key_back", keys.backKey.isPressed());
            event.addProperty("key_left", keys.leftKey.isPressed());
            event.addProperty("key_right", keys.rightKey.isPressed());
            event.addProperty("key_use", keys.useKey.isPressed());
            append("urgent-danger.jsonl", event + "\n");
        }
        lastFuseCheckNs = fuseCheckNs;
        lastFuseCheckTick = tick;
        var explosion = ears.takeExplosionCue();
        if (fuseOrigin != null) {
            if (explosion != null) {
                JsonObject event = dangerEvent("explosion", client);
                soundFields(event, explosion);
                append("urgent-danger.jsonl", event + "\n");
            }
            long since = tick - fuseTick;
            if (since > 0 && (since == 1 || since % 4 == 0))
                append("urgent-danger.jsonl", dangerEvent("effect_sample", client) + "\n");
            if (since >= 48) {
                fuseOrigin = null;
                fuseCursorItem = null;
            }
        }
        if (macro != null) macro.end(progress, fleeing ? "A primed creeper owns emergency movement." :
            "The local safety or completion controller owns this tick.");
        observeContinuity(client, fleeing, fuse == null ? fuseOrigin : fuse.origin(),
            macro == null ? null : macro.continuityWork());
        boolean won = progress.won() && !hands.busy() && client.currentScreen == null && renderedScreen == null;
        if (won) {
            hands.cancel();
            releaseLifeInputs(client);
            ended = true;
            stopMacro("goal_completed", "The Survival goal was reached.");
        }
        progress.saveMemory(ended);
        publish(client, fleeing ? "evading a primed creeper" : progress.status(), won, null,
            false, 0);
    }

    private void observeContinuityIdle() {
        if (pauses == null) return;
        continuityPlayer = null;
        pauses.sample(tick, null, false, false, false);
    }

    private boolean runnerStopRequested() {
        if (!Files.isRegularFile(runnerStopMarker, LinkOption.NOFOLLOW_LINKS)) return false;
        try {
            var marker = Files.readAttributes(runnerStopMarker, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            return marker.isRegularFile() && marker.size() == 0 && marker.permissions().equals(PRIVATE_STOP_MODE)
                && marker.owner().equals(Files.getOwner(directory, LinkOption.NOFOLLOW_LINKS))
                && Integer.valueOf(1).equals(Files.getAttribute(runnerStopMarker, "unix:nlink", LinkOption.NOFOLLOW_LINKS));
        } catch (IOException | UnsupportedOperationException ignored) {
            return false;
        }
    }

    private void stopForRunner(MinecraftClient client) {
        stoppingForRunner = true;
        if (!ended && pauses != null) {
            ++tick;
            // The previous input may have genuinely advanced through this
            // tick. Do not reuse a prior macro classification or run policy.
            if (playing(client) && client.interactionManager != null)
                observeContinuity(client, false, null, null);
            else observeContinuityIdle();
        }
        ended = true;
        AgentWalkedRoute.Breadcrumbs pendingBreadcrumbs = null;
        if (body != null) {
            if (macro != null) {
                macro.closeFurnaceForStop();
                pendingBreadcrumbs = macro.pendingCloseBreadcrumbs();
            }
            hands.releaseWorkInventory(true);
            releaseLifeInputs(client);
        }
        if (pauses != null) pauses.close("runner_stop");
        stopMacro("actor_exit", "The owning runner ended the attempt.");
        if (body != null && pendingFurnaceMemory != null && lifePhase == LifePhase.PLAYING &&
                soleFurnaceActor(client, client.player))
            pendingFurnaceMemory.runnerClose(tick, body.renderedFrame(), pendingBreadcrumbs);
        client.scheduleStop();
    }

    private void observeContinuity(MinecraftClient client, boolean fleeing, Vec3d danger, AgentPauseEpisodes.Work work) {
        if (pauses == null) return;
        var player = client.player;
        double x = player.getX(), y = player.getY(), z = player.getZ();
        float yaw = player.getYaw(), pitch = player.getPitch();
        long gui = hands.workEvidence();
        boolean same = continuityPlayer == player;
        boolean keys = !body.keysNeutral();
        boolean camera = same && (Math.abs(MathHelper.wrapDegrees(yaw - continuityYaw)) > 0.03f
            || Math.abs(pitch - continuityPitch) > 0.03f);
        boolean guiChanged = same && gui != continuityGui;
        if (!same) {
            continuityMine = null;
            continuityCrack = 0;
            continuityLanding = null;
            continuityRouteSteps = 0;
            Arrays.fill(recentContinuityLandings, null);
            continuityLandingCursor = 0;
            continuityBreak = false;
        }

        BlockPos target = body.continuityMiningTarget();
        if (target != null) {
            if (!target.equals(continuityMine)) {
                continuityMine = target;
                continuityCrack = 0;
            }
            if (work != AgentPauseEpisodes.Work.CRACK && client.interactionManager.isBreakingBlock()
                    && client.interactionManager instanceof AgentMiningAccess mining
                    && target.equals(mining.agent$breakingPos())) {
                float crack = mining.agent$breakingProgress();
                if (crack > continuityCrack && crack <= 1) {
                    continuityCrack = crack;
                    work = AgentPauseEpisodes.Work.CRACK;
                }
            }
        }
        if (continuityBreak) {
            continuityBreak = false;
            continuityCrack = 0;
            work = AgentPauseEpisodes.Work.CRACK;
        }

        Vec3d landing = body.continuityLanding();
        if (landing == null || !same || player.horizontalCollision) {
            continuityRouteSteps = 0;
        } else {
            double distance = Math.hypot(x - landing.x, z - landing.z);
            if (!landing.equals(continuityLanding)) {
                continuityLanding = landing;
                continuityRouteStart = continuityRouteBest = distance;
                continuityRouteSteps = 0;
                creditedContinuityLanding = revisitingContinuityLanding = false;
                for (Vec3d prior : recentContinuityLandings) {
                    if (prior != null && prior.squaredDistanceTo(landing) < 0.09) {
                        revisitingContinuityLanding = true;
                        break;
                    }
                }
            } else if (continuityRouteBest - distance >= 0.018) {
                continuityRouteBest = distance;
                ++continuityRouteSteps;
                if (!revisitingContinuityLanding && continuityRouteSteps >= 3 && continuityRouteStart - distance >= 0.18) {
                    if (work == null) work = AgentPauseEpisodes.Work.ROUTE;
                    if (!creditedContinuityLanding) {
                        recentContinuityLandings[continuityLandingCursor] = landing;
                        continuityLandingCursor = (continuityLandingCursor + 1) % recentContinuityLandings.length;
                        creditedContinuityLanding = true;
                    }
                }
            } else {
                continuityRouteSteps = 0;
            }
        }
        if (work == null && same && fleeing && keys && danger != null
                && danger.squaredDistanceTo(x, y, z) > danger.squaredDistanceTo(continuityX, continuityY, continuityZ) + 0.04)
            work = AgentPauseEpisodes.Work.SAFETY;
        if (work == null && guiChanged) work = AgentPauseEpisodes.Work.GUI;
        if (work == null && progress.continuityMechanicalWait()) work = AgentPauseEpisodes.Work.MECHANICAL_WAIT;
        pauses.sample(tick, work, keys || camera || guiChanged, camera,
            macro != null && macro.planningState().equals("blocked/no_safe_action"));
        continuityPlayer = player;
        continuityX = x;
        continuityY = y;
        continuityZ = z;
        continuityYaw = yaw;
        continuityPitch = pitch;
        continuityGui = gui;
    }

    private static double millis(long nanos) { return nanos / 1_000_000.0; }

    private static String screenKind(Screen screen) {
        return screen == null ? "world" : screen instanceof InventoryScreen ? "inventory" :
            screen instanceof CraftingScreen ? "crafting_table" : "other";
    }

    private static void position(JsonObject event, String key, Vec3d p) {
        JsonArray xyz = new JsonArray(3);
        xyz.add(p.x);
        xyz.add(p.y);
        xyz.add(p.z);
        event.add(key, xyz);
    }

    private static int countItem(PlayerInventory inventory, Item item) {
        int result = 0;
        for (int i = 0; i < inventory.size(); ++i) {
            var stack = inventory.getStack(i);
            if (stack.isOf(item)) result += stack.getCount();
        }
        return result;
    }

    private JsonObject dangerEvent(String kind, MinecraftClient client) {
        JsonObject event = new JsonObject();
        event.addProperty("kind", kind);
        event.addProperty("tick", tick);
        event.addProperty("wall_ms", System.currentTimeMillis());
        event.addProperty("mono_ms", millis(System.nanoTime()));
        event.addProperty("fuse_tick", fuseTick);
        lifeFields(event, client.player);
        event.addProperty("health", client.player.getHealth());
        event.addProperty("hurt_time", client.player.hurtTime);
        event.addProperty("blocking", client.player.isBlocking());
        event.addProperty("cursor_item_inventory_count", fuseCursorItem == null ? 0 :
            countItem(client.player.getInventory(), fuseCursorItem));
        event.addProperty("active_cursor_count", client.player.currentScreenHandler.getCursorStack().getCount());
        position(event, "player", client.player.getPos());
        // Evidence only. Exact sound coordinates do not leave this private journal or influence movement.
        event.addProperty("distance_from_fuse_origin", client.player.getPos().distanceTo(fuseOrigin));
        return event;
    }

    private static void soundFields(JsonObject event, AgentEars.SoundCue cue) {
        event.addProperty("cue_wall_ms", cue.wallMs());
        event.addProperty("cue_mono_ms", millis(cue.monotonicNs()));
        event.addProperty("cue_screen", screenKind(cue.screen()));
        event.addProperty("cue_screen_rendered", cue.shown());
        event.addProperty("cue_health", cue.health());
        position(event, "cue_player", cue.player());
        position(event, "cue_origin", cue.origin());
    }

    private void publish(MinecraftClient client, String status, boolean won, String failure, boolean boundary,
                         long wallMs) {
        var player = admittedPlayer(client);
        String owner = macro == null ? "deterministic" : macro.owner();
        String planningState = macro == null ? "" : macro.planningState();
        String planningEvidence = macro == null ? "" : macro.planningEvidence();
        long purposefulTick = macro == null ? 0 : macro.lastPurposefulTick();
        boolean planningChanged = !planningState.equals(lastPlanningState)
            || !planningEvidence.equals(lastPlanningEvidence) || purposefulTick != lastPurposefulTick;
        boolean ownerChanged = !owner.equals(lastOwner);
        if (tick % 2 == 0 || ended || boundary || ownerChanged || macro != null && macro.trial())
            recordMovement(client, player, status);
        if (ended) closeMovement();
        String handStatus = hands.status();
        var receipt = hands.lastCraftReceipt();
        if (receipt != null && receipt.sequence() != craftSequence) {
            craftSequence = receipt.sequence();
            JsonObject craft = new JsonObject();
            craft.addProperty("tick", tick);
            craft.addProperty("wall_ms", System.currentTimeMillis());
            craft.addProperty("recipe", receipt.recipe());
            craft.addProperty("executions", receipt.executions());
            craft.addProperty("items", receipt.items());
            craft.addProperty("shift_clicks", receipt.shiftClicks());
            craft.addProperty("revision", receipt.revision());
            append("crafts.jsonl", craft + "\n");
        }
        var stall = progress.stallReport();
        var returnableDrop = progress.returnableDrop();
        boolean newReturnableDrop = returnableDrop != null && returnableDrop.sequence() != returnableDropSequence;
        boolean newlyBlocked = stall.eventSequence() != stallSequence && stall.phase().equals("blocked");
        if (macro != null) {
            recordHorizon(body.visibleHorizon().takePreviewEvidence());
            recordHorizon(body.visibleHorizon().takeDriveEvidence());
        }
        recordHorizon(body.visibleHorizon().takeWadeEvidence());
        JsonObject surveyTransition = macro == null ? null : macro.takeSurveyTransition(tick);
        JsonObject wallTransition = macro == null ? null : macro.takeProspectWallTransition(tick);
        boolean privateTransition = surveyTransition != null || wallTransition != null;
        boolean touchingWater = player != null && player.isTouchingWater();
        boolean changed = screenChanged || ownerChanged || planningChanged || newReturnableDrop || !status.equals(lastStatus)
            || !handStatus.equals(lastHands) || stall.eventSequence() != stallSequence || touchingWater != lastTouchingWater;
        if (changed || privateTransition || boundary || tick % 20 == 0 || ended || tick == 1) {
            JsonObject event = new JsonObject();
            event.addProperty("tick", tick);
            event.addProperty("wall_ms", boundary ? wallMs : System.currentTimeMillis());
            event.addProperty("status", status);
            event.addProperty("stall_phase", stall.phase());
            event.addProperty("stall_detail", stall.detail());
            event.addProperty("stall_incidents", priorStallIncidents + stall.incidents());
            event.addProperty("stall_attempts", priorStallAttempts + stall.attempts());
            event.addProperty("stall_recoveries", priorStallRecoveries + stall.recoveries());
            event.addProperty("stall_failures", priorStallFailures + stall.failures());
            event.addProperty("stall_incident_tick", stall.incidentTick());
            var ceiling = body.headroomReport();
            event.addProperty("short_jumps", priorShortJumps + ceiling.shortJumps());
            event.addProperty("headroom_cleared", priorHeadroomCleared + ceiling.cleared());
            event.addProperty("headroom_bypasses", priorHeadroomBypasses + ceiling.bypasses());
            event.addProperty("headroom_action", ceiling.reason());
            event.addProperty("hands", handStatus);
            event.addProperty("goal", goal);
            if (macro != null) {
                event.addProperty("control_owner", owner);
                event.addProperty("macro_trial", macro.trial());
                macro.addPlanningTelemetry(event);
            }
            lifeFields(event, player);
            event.addProperty("won", won);
            if (failure != null) event.addProperty("failure", failure);
            JsonObject counts = new JsonObject();
            if (player != null) {
                event.addProperty("health", player.getHealth());
                event.addProperty("x", player.getX());
                event.addProperty("y", player.getY());
                event.addProperty("z", player.getZ());
                event.addProperty("yaw", player.getYaw());
                event.addProperty("pitch", player.getPitch());
                event.addProperty("sprinting", player.isSprinting());
                event.addProperty("food", player.getHungerManager().getFoodLevel());
                event.addProperty("touching_water", touchingWater);
                if (macro != null) {
                    event.addProperty("macro_grounded", macro.grounded());
                    event.addProperty("macro_neutral", macro.neutral());
                    event.addProperty("macro_cursor_clear", macro.cursorClear());
                    event.addProperty("macro_hazard_clear", macro.hazardClear());
                }
                event.addProperty("blocking", player.isBlocking());
                event.addProperty("offhand", Registries.ITEM.getId(player.getOffHandStack().getItem()).toString());
                event.addProperty("armor_points", player.getArmor());
                PlayerInventory inventory = player.getInventory();
                for (int i = 0; i < inventory.size(); ++i) {
                    var stack = inventory.getStack(i);
                    if (stack.isEmpty()) continue;
                    String id = Registries.ITEM.getId(stack.getItem()).toString();
                    counts.addProperty(id, stack.getCount() + (counts.has(id) ? counts.get(id).getAsInt() : 0));
                }
            }
            event.add("inventory", counts);
            event.addProperty("yaw_travel", yawTravel);
            event.addProperty("pitch_travel", pitchTravel);
            event.addProperty("sprint_ticks", sprintTicks);
            event.addProperty("rock_broken", rockBroken);
            event.addProperty("cave_openings", priorCaveOpenings + progress.caveOpenings());
            event.addProperty("cave_steps", priorCaveSteps + progress.caveFootsteps());
            if (returnableDrop != null) {
                event.addProperty("returnable_drop_sequence", returnableDrop.sequence());
                if (newReturnableDrop) {
                    JsonObject proof = new JsonObject();
                    proof.add("upper", coordinates(returnableDrop.upper()));
                    proof.add("lower", coordinates(returnableDrop.lower()));
                    proof.addProperty("body_tick", returnableDrop.renderedTick());
                    event.add("returnable_drop", proof);
                }
            }
            event.addProperty("water_drop_attempts", priorWaterAttempts + progress.fall().waterAttempts());
            event.addProperty("water_drop_landings", priorWaterLandings + progress.fall().waterSuccesses());
            event.addProperty("boat_attempts", priorBoatAttempts + progress.fall().boatAttempts());
            event.addProperty("boat_landings", priorBoatLandings + progress.fall().boatSuccesses());
            event.addProperty("meals_eaten", priorMeals + progress.mealsEaten());
            event.addProperty("food_picked_up", priorFoodPickedUp + progress.foodPickedUp());
            event.addProperty("craft_shift_presses", priorShiftPresses + hands.craftShiftClicks());
            if (client.world != null && sameConnection(client))
                event.addProperty("dimension", client.world.getRegistryKey().getValue().toString());
            if (goal.equals("nether_portal")) {
                event.addProperty("frame_blocks", progress.confirmedFrameBlocks());
                event.addProperty("cast_frame_blocks", progress.castFrameBlocks());
                event.addProperty("cast_passive_blocks", progress.castPassiveBlocks());
                event.addProperty("cast_lava_deposits", progress.castLavaDeposits());
                if (progress.castFrameBlocks() == 10 && progress.castPassiveBlocks() == 2) {
                    var report = progress.shoreCastReport();
                    event.addProperty("cast_method", "shore");
                    event.add("cast_passive_cells", coordinates(report.passiveFrameCells()));
                    event.add("cast_poured_cells", coordinates(report.pouredFrameCells()));
                }
                event.addProperty("cast_phase", progress.castPhase());
                event.addProperty("cast_survey_evidence", progress.castSurveyEvidence());
                event.addProperty("lava_sources_seen", progress.witnessedLavaSources());
                event.addProperty("ignited", progress.ignited());
            }
            event.addProperty("gui", client.currentScreen != null);
            event.addProperty("rendered_screen", screenKind(renderedScreen));
            event.addProperty("personal_opens", personalOpens);
            event.addProperty("bench_opens", benchOpens);
            boolean updateProgress = tick == 1 || tick % 20 == 0 || boundary || ended || newlyBlocked || ownerChanged || planningChanged;
            String line = !privateTransition || updateProgress ? event + "\n" : null;
            try {
                if (privateTransition) {
                    if (surveyTransition != null) event.add("macro_survey_transition", surveyTransition);
                    if (wallTransition != null) event.add("macro_prospect_wall_transition", wallTransition);
                    append("events.jsonl", event + "\n");
                } else if (changed || boundary || ended || tick % 100 == 0) append("events.jsonl", line);
                if (updateProgress) {
                    Path part = directory.resolve("progress.tmp");
                    Files.writeString(part, line);
                    Files.move(part, directory.resolve("progress.json"), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException e) { body.release(); ended = true; throw new UncheckedIOException(e); }
            lastStatus = status;
            lastHands = handStatus;
            lastOwner = owner;
            lastTouchingWater = touchingWater;
            lastPlanningState = planningState;
            lastPlanningEvidence = planningEvidence;
            lastPurposefulTick = purposefulTick;
            stallSequence = stall.eventSequence();
            if (newReturnableDrop) returnableDropSequence = returnableDrop.sequence();
            screenChanged = false;
        }
    }
}
