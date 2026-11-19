package io.gameharness.pilot;

import com.google.gson.JsonObject;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Set;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.fabricmc.fabric.api.event.client.player.ClientPlayerBlockBreakEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.ingame.CraftingScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.block.Blocks;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.MathHelper;
import net.minecraft.world.GameMode;

/** Private run telemetry observes the player. No command, server or world-data input channel. */
public final class PilotClient implements ClientModInitializer {
    private static PilotClient active;
    private Path directory;
    private String goal;
    private PilotHands hands;
    private PilotBody body;
    private PilotProgress progress;
    private PilotEars ears;
    private long tick;
    private String lastStatus = "";
    private String lastHands = "";
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
    private boolean ended;

    @Override public void onInitializeClient() {
        String output = System.getProperty("gh.pilot.dir", System.getenv("GH_PILOT_DIR"));
        goal = System.getProperty("gh.pilot.goal", System.getenv("GH_PILOT_GOAL"));
        if (output == null && goal == null) return;
        if (output == null || goal == null || !Set.of("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond", "nether_portal").contains(goal))
            throw new IllegalArgumentException("Expected a pilot directory and supported survival goal");
        directory = Path.of(output).toAbsolutePath();
        if (!Files.isDirectory(directory)) throw new IllegalStateException("Missing private pilot directory");
        active = this;
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            if (progress != null) progress.saveMemory(true);
            closeMovement();
        });
        ClientTickEvents.START_CLIENT_TICK.register(this::drive);
        WorldRenderEvents.START.register(context -> {
            if (progress != null && !ended) body.observeFrame(context);
        });
        ClientPlayerBlockBreakEvents.AFTER.register((world, player, pos, state) -> {
            if (progress == null || ended) return;
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

    private void recordMovement(MinecraftClient client, String activity) {
        // Sample the actual player, not the commanded angles or requested sprint key.
        var p = client.player;
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
            if (tick % 20 == 0) movement.flush();
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }

    private void closeMovement() {
        if (movement == null) return;
        try { movement.close(); }
        catch (IOException e) { throw new UncheckedIOException(e); }
        finally { movement = null; }
    }

    public static void steerFrame() {
        if (active != null && active.progress != null && !active.ended) {
            Screen shown = MinecraftClient.getInstance().currentScreen;
            if (shown != active.renderedScreen) {
                active.renderedScreen = shown;
                active.screenChanged = true;
                if (shown instanceof InventoryScreen) ++active.personalOpens;
                else if (shown instanceof CraftingScreen) ++active.benchOpens;
            }
            active.body.frame();
            active.hands.frame();
            var player = MinecraftClient.getInstance().player;
            if (player != null && shown == null) {
                float yaw = player.getYaw();
                if (Float.isFinite(active.lastYaw)) active.yawTravel += Math.abs(MathHelper.wrapDegrees(yaw - active.lastYaw));
                float pitch = player.getPitch();
                if (Float.isFinite(active.lastPitch)) active.pitchTravel += Math.abs(pitch - active.lastPitch);
                active.lastYaw = yaw;
                active.lastPitch = pitch;
            } else active.lastYaw = active.lastPitch = Float.NaN;
        }
    }

    private void drive(MinecraftClient client) {
        if (ended) return;
        if (client.player == null || client.world == null || client.interactionManager == null) {
            // The client can briefly drop the old world during dimension travel.
            // Release input, but let a live connection resume in its replacement world.
            if (progress != null) {
                body.release();
                if (client.getNetworkHandler() == null) { closeMovement(); ended = true; }
            }
            return;
        }
        if (progress == null) {
            if (client.currentScreen != null) return;
            if (client.getNetworkHandler() == null ||
                !(client.getNetworkHandler().getConnection().getAddress() instanceof InetSocketAddress peer) ||
                peer.getAddress() == null || !peer.getAddress().isLoopbackAddress() ||
                client.interactionManager.getCurrentGameMode() != GameMode.SURVIVAL) return;
            body = new PilotBody(client);
            hands = new PilotHands(client);
            progress = new PilotProgress(client, body, hands, goal, new PilotMemory(directory));
            ears = new PilotEars(client);
            client.getSoundManager().registerListener(ears);
        }
        if (client.player.isAlive() && !progress.restoreMemory()) return;
        ++tick;
        if (client.player.isSprinting()) ++sprintTicks;
        boolean alive = client.player.isAlive();
        boolean fleeing = false;
        if (alive) {
            body.begin();
            fleeing = ears.escape(body, hands);
            if (!fleeing) {
                hands.tick();
                progress.tick();
            }
            body.finish();
        }
        boolean won = alive && progress.won() && !hands.busy() && client.currentScreen == null && renderedScreen == null;
        if (won || !alive || progress.failure() != null) { hands.cancel(); body.release(); ended = true; }
        if (alive) progress.saveMemory(ended);
        String status = !alive ? "dead" : fleeing ? "evading a primed creeper" : progress.status();
        if (tick % 2 == 0 || ended) recordMovement(client, status);
        if (ended) closeMovement();
        String handStatus = hands.status();
        boolean changed = screenChanged || !status.equals(lastStatus) || !handStatus.equals(lastHands);
        if (changed || tick % 20 == 0 || ended || tick == 1) {
            JsonObject event = new JsonObject();
            event.addProperty("tick", tick);
            event.addProperty("wall_ms", System.currentTimeMillis());
            event.addProperty("status", status);
            event.addProperty("hands", handStatus);
            event.addProperty("goal", goal);
            event.addProperty("alive", alive);
            event.addProperty("won", won);
            if (progress.failure() != null) event.addProperty("failure", progress.failure());
            event.addProperty("health", client.player.getHealth());
            event.addProperty("x", client.player.getX());
            event.addProperty("y", client.player.getY());
            event.addProperty("z", client.player.getZ());
            event.addProperty("yaw", client.player.getYaw());
            event.addProperty("yaw_travel", yawTravel);
            event.addProperty("pitch", client.player.getPitch());
            event.addProperty("pitch_travel", pitchTravel);
            event.addProperty("sprinting", client.player.isSprinting());
            event.addProperty("sprint_ticks", sprintTicks);
            event.addProperty("rock_broken", rockBroken);
            event.addProperty("food", client.player.getHungerManager().getFoodLevel());
            event.addProperty("dimension", client.world.getRegistryKey().getValue().toString());
            if (goal.equals("nether_portal")) {
                event.addProperty("frame_blocks", progress.confirmedFrameBlocks());
                event.addProperty("ignited", progress.ignited());
            }
            event.addProperty("gui", client.currentScreen != null);
            event.addProperty("rendered_screen", renderedScreen == null ? "world" :
                renderedScreen instanceof InventoryScreen ? "inventory" :
                renderedScreen instanceof CraftingScreen ? "crafting_table" : "other");
            event.addProperty("personal_opens", personalOpens);
            event.addProperty("bench_opens", benchOpens);
            JsonObject counts = new JsonObject();
            PlayerInventory inventory = client.player.getInventory();
            for (int i = 0; i < inventory.size(); ++i) {
                var stack = inventory.getStack(i);
                if (stack.isEmpty()) continue;
                String id = Registries.ITEM.getId(stack.getItem()).toString();
                counts.addProperty(id, stack.getCount() + (counts.has(id) ? counts.get(id).getAsInt() : 0));
            }
            event.add("inventory", counts);
            String line = event + "\n";
            try {
                if (changed || ended || tick % 100 == 0) append("events.jsonl", line);
                if (tick == 1 || tick % 20 == 0 || ended) {
                    Path part = directory.resolve("progress.tmp");
                    Files.writeString(part, line);
                    Files.move(part, directory.resolve("progress.json"), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException e) { body.release(); ended = true; throw new UncheckedIOException(e); }
            lastStatus = status;
            lastHands = handStatus;
            screenChanged = false;
        }
    }
}
