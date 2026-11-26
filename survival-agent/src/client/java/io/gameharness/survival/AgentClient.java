package io.gameharness.survival;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Set;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.world.GameMode;

/**
 * Clean, modular Fabric 1.21.4 Survival Agent entrypoint.
 * Coordinates 60fps smooth motor/GUI rendering, 20tps perception, A* navigation,
 * autonomous survival reflexes, high-level tasks, and async LLM strategy.
 */
public final class AgentClient implements ClientModInitializer {
    private static final Set<String> SUPPORTED_GOALS = Set.of(
        "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "diamond_pickaxe", "nether_portal"
    );

    private static AgentClient active;

    private Path directory;
    private Path runnerStopMarker;
    private String goal;
    private boolean diagnosticRevealOres;
    private boolean allowRespawn;

    private Motor motor;
    private Perception perception;
    private Pathfinder pathfinder;
    private RouteExecutor route;
    private GuiHands gui;
    private SurvivalReflexes reflexes;
    private TaskRunner tasks;
    private StrategistBridge strategist;
    private AgentPauseEpisodes pauses;

    private long tick;
    private int life = 1;
    private int deaths;
    private int respawns;
    private boolean wasDead;
    private boolean ended;
    private long startWallMs;
    private long lastProgressWriteMs;
    private float lastYaw = Float.NaN;
    private float lastPitch = Float.NaN;
    private double lastX = Double.NaN, lastY = Double.NaN, lastZ = Double.NaN;

    @Override
    public void onInitializeClient() {
        String outDir = System.getProperty("gh.agent.dir", System.getenv("GH_AGENT_DIR"));
        goal = System.getProperty("gh.agent.goal", System.getenv("GH_AGENT_GOAL"));
        if (outDir == null && goal == null) return;
        if (outDir == null || goal == null || !SUPPORTED_GOALS.contains(goal)) {
            throw new IllegalArgumentException("Expected valid gh.agent.dir and supported gh.agent.goal");
        }
        directory = Path.of(outDir).toAbsolutePath();
        if (!Files.isDirectory(directory)) {
            throw new IllegalStateException("Missing private agent directory: " + directory);
        }
        runnerStopMarker = directory.resolve("runner-stop-" + directory.getFileName());
        diagnosticRevealOres = Boolean.parseBoolean(System.getProperty("gh.agent.reveal_ores", "false"));
        allowRespawn = Files.isRegularFile(directory.resolve("allow-vanilla-respawn"), LinkOption.NOFOLLOW_LINKS);
        startWallMs = System.currentTimeMillis();
        active = this;

        ClientTickEvents.END_CLIENT_TICK.register(this::onTick);
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> shutdown("actor_exit"));
    }

    /** Called every render frame from AgentRenderMixin BEFORE camera update (60fps!). */
    public static void steerFrame() {
        AgentClient a = active;
        if (a == null || a.ended) return;
        if (a.gui != null && a.gui.isBusy()) {
            a.gui.renderFrame();
        } else if (a.motor != null) {
            a.motor.steerFrame();
        }
    }

    private void initSubsystems(MinecraftClient client) {
        if (motor != null) return;
        motor = new Motor(client);
        perception = new Perception(client, diagnosticRevealOres);
        pathfinder = new Pathfinder();
        route = new RouteExecutor(client, motor, perception);
        gui = new GuiHands(client);
        reflexes = new SurvivalReflexes(client, motor, perception, gui);
        tasks = new TaskRunner(client, motor, perception, pathfinder, route, gui, goal);
        strategist = StrategistBridge.open(directory, goal);
        pauses = new AgentPauseEpisodes(directory, 0);
    }

    private void onTick(MinecraftClient client) {
        if (ended) return;

        // Respect clean runner stop marker immediately
        if (Files.exists(runnerStopMarker, LinkOption.NOFOLLOW_LINKS)) {
            if (motor != null) motor.releaseKeys();
            if (tick > 0) publishProgress(client, "stopping for runner", false, wasDead ? "death_screen" : "playing");
            shutdown("runner_stop");
            return;
        }

        if (client.world == null || client.player == null) return;
        if (client.interactionManager == null || client.interactionManager.getCurrentGameMode() != GameMode.SURVIVAL) return;

        initSubsystems(client);
        tick++;
        ClientPlayerEntity player = client.player;

        // 1. Handle death & vanilla respawn cleanly!
        if (!player.isAlive() || player.getHealth() <= 0f || client.currentScreen instanceof DeathScreen) {
            motor.releaseKeys();
            gui.abort();
            if (!wasDead) {
                wasDead = true;
                deaths++;
                writeLifeReceipt(false, "death_screen");
                appendEvent("death", "Player died at " + player.getBlockPos().toShortString());
            }
            if (allowRespawn && client.currentScreen instanceof DeathScreen ds) {
                gui.tickDeathScreen(ds);
                publishProgress(client, "respawning", false, "death_screen");
            } else {
                publishProgress(client, "dead", false, "death_screen");
            }
            return;
        }

        if (wasDead) {
            wasDead = false;
            respawns++;
            life = respawns + 1;
            perception.resetForLife();
            tasks.resetForLife();
            writeLifeReceipt(true, "playing");
            appendEvent("respawn", "Respawned into life " + life);
        }

        // 2. Check goal victory!
        if (hasAchievedGoal(player)) {
            motor.releaseKeys();
            publishProgress(client, "goal verified: " + goal, true, "playing");
            appendEvent("goal_won", "Achieved goal " + goal + " at tick " + tick);
            ended = true;
            shutdown("goal_completed");
            return;
        }

        // 3. Tick perception (sight rays + optical sight + combat flow + optional diagnostic ore scan)
        perception.tick((int) tick);

        // 4. Poll any new macro plan from the async LLM strategist!
        if (strategist != null) {
            StrategistBridge.IncomingPlan plan = strategist.pollNewPlan(tick);
            if (plan != null) {
                tasks.applyModelPlan(plan.tasks(), plan.replaceQueue(), plan.safeExcavation());
                appendEvent("model_plan_applied", plan.planId() + ": " + plan.rationale());
            }
        }

        // 5. Run motor tick -> survival reflexes -> foreground tasks!
        motor.beginTick();
        boolean reflexActive = reflexes.tick((int) tick);
        if (!reflexActive) {
            tasks.tick((int) tick);
        }
        motor.applyKeys();

        // 6. Publish pause-timeline evidence
        samplePauseTimeline(player, reflexActive);

        // 7. Periodically publish state to LLM strategist & progress.json to run.ts!
        if (strategist != null && (tick % 15 == 0 || tick <= 2)) {
            strategist.publishState(player, client.world, perception, tasks, reflexes, life, tick);
        }
        long nowMs = System.currentTimeMillis();
        if (tick % 5 == 0 || nowMs - lastProgressWriteMs >= 250) {
            lastProgressWriteMs = nowMs;
            String st = reflexes.activeStatus() != null ? reflexes.activeStatus() : tasks.statusText();
            publishProgress(client, st, false, "playing");
        }
    }

    private boolean hasAchievedGoal(ClientPlayerEntity player) {
        return switch (goal) {
            case "wooden_pickaxe" -> GuiHands.countItem(player, Items.WOODEN_PICKAXE) > 0;
            case "stone_pickaxe" -> GuiHands.countItem(player, Items.STONE_PICKAXE) > 0;
            case "iron_pickaxe" -> GuiHands.countItem(player, Items.IRON_PICKAXE) > 0;
            case "diamond" -> GuiHands.countItem(player, Items.DIAMOND) > 0;
            case "diamond_pickaxe" -> GuiHands.countItem(player, Items.DIAMOND_PICKAXE) > 0;
            case "nether_portal" -> player.getWorld().getRegistryKey().getValue().toString().equals("minecraft:the_nether");
            default -> false;
        };
    }

    private void samplePauseTimeline(ClientPlayerEntity player, boolean reflexActive) {
        if (pauses == null) return;
        boolean moved = Double.isFinite(lastX)
            && Math.hypot(player.getX() - lastX, player.getZ() - lastZ) > 0.03;
        boolean camMoved = Float.isFinite(lastYaw)
            && (Math.abs(player.getYaw() - lastYaw) > 0.1 || Math.abs(player.getPitch() - lastPitch) > 0.1);
        AgentPauseEpisodes.Work work = null;
        if (motor.isMining()) work = AgentPauseEpisodes.Work.CRACK;
        else if (gui.isBusy()) work = AgentPauseEpisodes.Work.GUI;
        else if (reflexActive) work = AgentPauseEpisodes.Work.SAFETY;
        else if (moved) work = AgentPauseEpisodes.Work.ROUTE;
        else if (tasks.statusText().startsWith("waiting for furnace")) work = AgentPauseEpisodes.Work.MECHANICAL_WAIT;

        pauses.sample(tick, work, motor.anyMovementKey() || gui.isBusy(), camMoved, false);
        lastX = player.getX();
        lastY = player.getY();
        lastZ = player.getZ();
        lastYaw = player.getYaw();
        lastPitch = player.getPitch();
    }

    private void publishProgress(MinecraftClient client, String status, boolean won, String lifePhase) {
        ClientPlayerEntity player = client.player;
        boolean alive = "playing".equals(lifePhase) && player != null && player.isAlive() && player.getHealth() > 0f;
        JsonObject obj = new JsonObject();
        obj.addProperty("tick", Math.max(1L, tick));
        obj.addProperty("goal", goal);
        obj.addProperty("status", status);
        obj.addProperty("won", won && alive);
        obj.addProperty("alive", alive);
        obj.addProperty("wall_ms", System.currentTimeMillis() - startWallMs);
        obj.addProperty("deaths", deaths);
        obj.addProperty("respawns", respawns);
        obj.addProperty("life", respawns + 1);
        obj.addProperty("life_phase", alive ? "playing" : "death_screen");
        obj.addProperty("rock_broken", tasks == null ? 0 : tasks.rockBrokenCount());
        if (alive) {
            obj.addProperty("x", player.getX());
            obj.addProperty("y", player.getY());
            obj.addProperty("z", player.getZ());
            obj.addProperty("health", player.getHealth());
            obj.addProperty("dimension", player.getWorld().getRegistryKey().getValue().toString());
            JsonObject inv = new JsonObject();
            var pinv = player.getInventory();
            for (int i = 0; i < pinv.size(); i++) {
                ItemStack st = pinv.getStack(i);
                if (st.isEmpty()) continue;
                String id = Registries.ITEM.getId(st.getItem()).toString();
                inv.addProperty(id, st.getCount() + (inv.has(id) ? inv.get(id).getAsInt() : 0));
            }
            obj.add("inventory", inv);
        }
        try {
            Path tmp = directory.resolve(".progress.tmp");
            Files.writeString(tmp, obj.toString() + "\n", StandardCharsets.UTF_8);
            Files.move(tmp, directory.resolve("progress.json"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException ignored) {}
    }

    private void writeLifeReceipt(boolean alive, String phase) {
        if (deaths <= 0) return;
        JsonObject obj = new JsonObject();
        obj.addProperty("tick", Math.max(1L, tick));
        obj.addProperty("wall_ms", System.currentTimeMillis() - startWallMs);
        obj.addProperty("alive", alive);
        obj.addProperty("deaths", deaths);
        obj.addProperty("respawns", respawns);
        obj.addProperty("life", respawns + 1);
        obj.addProperty("life_phase", phase);
        try {
            Path file = directory.resolve("lives.jsonl");
            boolean existed = Files.exists(file, LinkOption.NOFOLLOW_LINKS);
            Files.writeString(file, obj + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            if (!existed) {
                Files.setPosixFilePermissions(file, java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
            }
        } catch (IOException ignored) {}
    }

    private void appendEvent(String event, String detail) {
        JsonObject obj = new JsonObject();
        obj.addProperty("tick", tick);
        obj.addProperty("wall_ms", System.currentTimeMillis() - startWallMs);
        obj.addProperty("event", event);
        obj.addProperty("detail", detail);
        try {
            Files.writeString(directory.resolve("events.jsonl"), obj + "\n", StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException ignored) {}
    }

    private void shutdown(String reason) {
        ended = true;
        if (motor != null) motor.releaseKeys();
        if (strategist != null) strategist.close();
        if (pauses != null) pauses.close(reason);
    }
}
