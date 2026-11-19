package io.gameharness.pilot;

import com.google.gson.JsonObject;
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
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.registry.Registries;
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
    private boolean ended;

    @Override public void onInitializeClient() {
        String output = System.getProperty("gh.pilot.dir", System.getenv("GH_PILOT_DIR"));
        goal = System.getProperty("gh.pilot.goal", System.getenv("GH_PILOT_GOAL"));
        if (output == null && goal == null) return;
        if (output == null || goal == null || !Set.of("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond").contains(goal))
            throw new IllegalArgumentException("Expected a pilot directory and supported item goal");
        directory = Path.of(output).toAbsolutePath();
        if (!Files.isDirectory(directory)) throw new IllegalStateException("Missing private pilot directory");
        active = this;
        ClientTickEvents.START_CLIENT_TICK.register(this::drive);
        WorldRenderEvents.START.register(context -> {
            if (progress != null && !ended) body.observeFrame(context);
        });
    }

    public static void steerFrame() {
        if (active != null && active.progress != null && !active.ended) {
            active.body.frame();
            active.hands.frame();
        }
    }

    private void drive(MinecraftClient client) {
        if (ended) return;
        if (client.player == null || client.world == null || client.interactionManager == null) {
            if (progress != null) { body.release(); ended = true; }
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
            progress = new PilotProgress(client, body, hands, goal);
            ears = new PilotEars(client);
            client.getSoundManager().registerListener(ears);
        }
        ++tick;
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
        boolean won = alive && progress.won();
        if (won || !alive) { body.release(); ended = true; }
        String status = !alive ? "dead" : fleeing ? "evading a primed creeper" : progress.status();
        String handStatus = hands.status();
        boolean changed = !status.equals(lastStatus) || !handStatus.equals(lastHands);
        if (changed || tick % 20 == 0 || ended || tick == 1) {
            JsonObject event = new JsonObject();
            event.addProperty("tick", tick);
            event.addProperty("wall_ms", System.currentTimeMillis());
            event.addProperty("status", status);
            event.addProperty("hands", handStatus);
            event.addProperty("goal", goal);
            event.addProperty("alive", alive);
            event.addProperty("won", won);
            event.addProperty("health", client.player.getHealth());
            event.addProperty("x", client.player.getX());
            event.addProperty("y", client.player.getY());
            event.addProperty("z", client.player.getZ());
            event.addProperty("yaw", client.player.getYaw());
            event.addProperty("pitch", client.player.getPitch());
            event.addProperty("gui", client.currentScreen != null);
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
                if (changed || ended || tick % 100 == 0) Files.writeString(directory.resolve("events.jsonl"), line,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);
                if (tick == 1 || tick % 20 == 0 || ended) {
                    Path part = directory.resolve("progress.tmp");
                    Files.writeString(part, line);
                    Files.move(part, directory.resolve("progress.json"), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException e) { body.release(); ended = true; throw new UncheckedIOException(e); }
            lastStatus = status;
            lastHands = handStatus;
        }
    }
}
