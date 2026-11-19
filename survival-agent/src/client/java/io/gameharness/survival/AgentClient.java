package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Set;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.fabricmc.fabric.api.event.client.player.ClientPlayerBlockBreakEvents;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.MathHelper;
import net.minecraft.world.GameMode;

/** Private run telemetry observes the player. No command, server or world-data input channel. */
public final class AgentClient implements ClientModInitializer {
    private static final long CONTROL_TIMEOUT = 15_000_000_000L;
    private static final long RESPAWN_TIMEOUT = 30_000_000_000L;

    private enum LifePhase {
        PLAYING("playing"), DEATH_SCREEN("death_screen"), RESPAWN_REQUESTED("respawn_requested");

        private final String id;
        LifePhase(String id) { this.id = id; }
    }

    private static AgentClient active;
    private Path directory;
    private String goal;
    private ClientPlayNetworkHandler network;
    private AgentHands hands;
    private AgentBody body;
    private AgentProgress progress;
    private AgentEars ears;
    private AgentMacroControl macro;
    private long tick;
    private String lastStatus = "";
    private String lastHands = "";
    private String lastOwner = "deterministic";
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
    private long craftSequence;
    private long stallSequence;
    private boolean allowRespawn;
    private LifePhase lifePhase = LifePhase.PLAYING;
    private int deaths, respawns;
    private ClientPlayerEntity deadPlayer;
    private AgentRespawn respawn;
    private long lifeDeadline;
    private long priorShiftPresses;
    private int priorStallIncidents, priorStallAttempts, priorStallRecoveries, priorStallFailures;
    private int priorShortJumps, priorHeadroomCleared, priorHeadroomBypasses;
    private int priorCaveOpenings, priorCaveSteps;
    private int priorWaterAttempts, priorWaterLandings, priorBoatAttempts, priorBoatLandings;
    private int priorMeals, priorFoodPickedUp;
    private boolean ended;

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

    @Override public void onInitializeClient() {
        String output = System.getProperty("gh.agent.dir", System.getenv("GH_AGENT_DIR"));
        goal = System.getProperty("gh.agent.goal", System.getenv("GH_AGENT_GOAL"));
        if (output == null && goal == null) return;
        if (output == null || goal == null || !Set.of("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal").contains(goal))
            throw new IllegalArgumentException("Expected an agent directory and supported survival goal");
        directory = Path.of(output).toAbsolutePath();
        if (!Files.isDirectory(directory)) throw new IllegalStateException("Missing private agent directory");
        allowRespawn = Files.isRegularFile(directory.resolve("allow-vanilla-respawn"), LinkOption.NOFOLLOW_LINKS);
        active = this;
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            stopMacro("The client is stopping.");
            if (macro != null) macro.drain();
            if (progress != null) progress.saveMemory(true);
            detachEars(client);
            closeMovement();
        });
        ClientTickEvents.START_CLIENT_TICK.register(this::drive);
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

    private static String finiteSample(double value) {
        return Double.isFinite(value) ? Double.toString(value) : "";
    }

    private void closeMovement() {
        try (BufferedWriter positions = movement; BufferedWriter actions = contacts) { /* close both writers */ }
        catch (IOException e) { throw new UncheckedIOException(e); }
        finally { movement = contacts = null; }
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
        network = handler;
        macro = AgentMacroControl.create(directory, goal);
        bindPolicy(client);
        return true;
    }

    private void bindPolicy(MinecraftClient client) {
        body = new AgentBody(client, this::recordContact);
        hands = new AgentHands(client);
        progress = new AgentProgress(client, body, hands, goal, new AgentMemory(directory));
        craftSequence = stallSequence = 0;
        if (client.player.isAlive()) {
            ears = new AgentEars(client);
            client.getSoundManager().registerListener(ears);
        }
    }

    private void detachEars(MinecraftClient client) {
        if (ears == null) return;
        client.getSoundManager().unregisterListener(ears);
        ears = null;
    }

    private void releaseLifeInputs(MinecraftClient client) {
        body.release();
        hands.discardLifeInputs();
        detachEars(client);
        lastYaw = lastPitch = Float.NaN;
    }

    private void stopMacro(String reason) {
        if (macro == null) return;
        macro.suspend(tick, reason);
        macro.close();
    }

    private boolean observeDeath(MinecraftClient client) {
        // Detached living entities can report !isAlive() on a world change; only zero health is death.
        if (lifePhase != LifePhase.PLAYING || !sameConnection(client)
            || client.player == null || !client.player.isDead()
            || (client.world != null && client.player.getWorld() != client.world)) return false;
        deadPlayer = client.player;
        if (macro != null) macro.suspend(tick, "The player died.");
        releaseLifeInputs(client);
        ++deaths;
        if (tick == 0) tick = 1;
        ended = !allowRespawn;
        transition(client, LifePhase.DEATH_SCREEN, "dead");
        progress.saveMemory(true);
        if (allowRespawn) {
            respawn = new AgentRespawn();
            lifeDeadline = System.nanoTime() + CONTROL_TIMEOUT;
        } else if (macro != null) macro.close();
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
        append("lives.jsonl", event + "\n");
        publish(client, status, false, null, true, now);
    }

    private void failLife(MinecraftClient client, String failure) {
        respawn = null;
        ended = true;
        stopMacro("Vanilla respawn failed.");
        publish(client, "respawn stopped", false, failure, true, System.currentTimeMillis());
    }

    private void drive(MinecraftClient client) {
        if (ended || (progress == null && !start(client))) return;
        if (tick == 0 && playing(client) && !progress.restoreMemory()) return;
        ++tick;
        if (!sameConnection(client)) {
            releaseLifeInputs(client);
            stopMacro("The admitted loopback connection closed.");
            if (lifePhase != LifePhase.PLAYING) failLife(client, "Connection closed before respawn completed.");
            else { ended = true; closeMovement(); }
            return;
        }
        if (observeDeath(client)) return;
        if (lifePhase != LifePhase.PLAYING) {
            recoverLife(client);
            return;
        }
        if (!playing(client) || client.interactionManager == null) {
            // World changes sometimes clear the actor while the original connection stays open.
            if (macro != null) macro.suspend(tick, "The player left the current Survival view.");
            body.release();
            hands.discardLifeInputs();
            lastYaw = lastPitch = Float.NaN;
            return;
        }
        if (!progress.restoreMemory()) return;
        if (client.player.isSprinting()) ++sprintTicks;
        progress.observeMemoryFooting(tick);
        body.begin();
        if (macro != null) macro.begin(client, body, hands, renderedScreen, tick, 1 + respawns);
        boolean fleeing = ears.escape(body, hands);
        if (!fleeing) {
            if (macro == null || !macro.engaged()) hands.tick();
            progress.tick(ears, macro);
        }
        body.finish();
        if (macro != null) macro.end(progress, fleeing ? "A primed creeper owns emergency movement." :
            "The local safety or completion controller owns this tick.");
        boolean won = progress.won() && !hands.busy() && client.currentScreen == null && renderedScreen == null;
        if (won) {
            hands.cancel();
            releaseLifeInputs(client);
            ended = true;
            stopMacro("The Survival goal was reached.");
        }
        progress.saveMemory(ended);
        publish(client, fleeing ? "evading a primed creeper" : progress.status(), won, null,
            false, 0);
    }

    private void publish(MinecraftClient client, String status, boolean won, String failure, boolean boundary,
                         long wallMs) {
        var player = admittedPlayer(client);
        String owner = macro == null ? "deterministic" : macro.owner();
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
        boolean newlyBlocked = stall.eventSequence() != stallSequence && stall.phase().equals("blocked");
        boolean changed = screenChanged || ownerChanged || !status.equals(lastStatus) || !handStatus.equals(lastHands) ||
            stall.eventSequence() != stallSequence;
        if (changed || boundary || tick % 20 == 0 || ended || tick == 1) {
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
                event.addProperty("macro_fallback_ticks", macro.fallbackTicks());
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
            event.addProperty("rendered_screen", renderedScreen == null ? "world" :
                renderedScreen instanceof InventoryScreen ? "inventory" :
                renderedScreen instanceof CraftingScreen ? "crafting_table" : "other");
            event.addProperty("personal_opens", personalOpens);
            event.addProperty("bench_opens", benchOpens);
            String line = event + "\n";
            try {
                if (changed || boundary || ended || tick % 100 == 0) append("events.jsonl", line);
                if (tick == 1 || tick % 20 == 0 || boundary || ended || newlyBlocked || ownerChanged) {
                    Path part = directory.resolve("progress.tmp");
                    Files.writeString(part, line);
                    Files.move(part, directory.resolve("progress.json"), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException e) { body.release(); ended = true; throw new UncheckedIOException(e); }
            lastStatus = status;
            lastHands = handStatus;
            lastOwner = owner;
            stallSequence = stall.eventSequence();
            screenChanged = false;
        }
    }
}
