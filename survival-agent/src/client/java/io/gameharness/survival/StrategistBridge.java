package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;

/**
 * Clean asynchronous file mailbox between the Java survival player and the
 * TypeScript provider-agnostic LLM strategist. Never blocks the Minecraft tick loop.
 */
final class StrategistBridge {
    record IncomingPlan(
        String planId,
        String rationale,
        boolean replaceQueue,
        Boolean safeExcavation,
        List<TaskRunner.Task> tasks
    ) {}

    private final Path dir;
    private final Path stateFile;
    private final Path planFile;
    private final String runId;
    private final String goal;
    private final ScheduledExecutorService io;
    private final AtomicReference<String> pendingStateJson = new AtomicReference<>();
    private final AtomicReference<IncomingPlan> incomingPlan = new AtomicReference<>();

    private String lastAppliedPlanId = "";
    private String lastAppliedRationale = "";
    private long lastAppliedTick = -1;
    private volatile boolean closed;

    static StrategistBridge open(Path runDir, String goal) {
        Path sub = runDir.resolve("strategist");
        if (!Files.isDirectory(sub, LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        return new StrategistBridge(sub, runDir.getFileName().toString(), goal);
    }

    private StrategistBridge(Path dir, String runId, String goal) {
        this.dir = dir;
        this.stateFile = dir.resolve("state.json");
        this.planFile = dir.resolve("plan.json");
        this.runId = runId;
        this.goal = goal;
        this.io = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "survival-strategist-io");
            t.setDaemon(true);
            return t;
        });
        this.io.scheduleWithFixedDelay(this::exchange, 0, 150, TimeUnit.MILLISECONDS);
    }

    void publishState(ClientPlayerEntity player, ClientWorld world, Perception perception,
                      TaskRunner runner, SurvivalReflexes reflexes, int life, long tick) {
        if (closed || player == null || world == null) return;
        JsonObject root = new JsonObject();
        root.addProperty("v", 2);
        root.addProperty("run", runId);
        root.addProperty("life", life);
        root.addProperty("tick", tick);
        root.addProperty("goal", goal);
        root.addProperty("health", Math.round(player.getHealth() * 10.0) / 10.0);
        root.addProperty("maxHealth", player.getMaxHealth());
        root.addProperty("food", player.getHungerManager().getFoodLevel());
        root.addProperty("x", Math.round(player.getX() * 10.0) / 10.0);
        root.addProperty("y", Math.round(player.getY() * 10.0) / 10.0);
        root.addProperty("z", Math.round(player.getZ() * 10.0) / 10.0);
        root.addProperty("timeOfDay", world.getTimeOfDay() % 24000L);
        root.addProperty("dimension", world.getRegistryKey().getValue().toString());
        root.addProperty("status", reflexes.activeStatus() != null ? reflexes.activeStatus() : runner.statusText());
        root.addProperty("safeExcavation", runner.isSafeExcavationMode());
        root.addProperty("combatFlowActive", perception.isCombatFlowActive());
        root.addProperty("diagnosticOreReveal", perception.isDiagnosticRevealOres());
        BlockPos cookingPos = runner.activeSmeltFurnacePos();
        if (cookingPos != null) {
            JsonObject f = new JsonObject();
            f.addProperty("x", cookingPos.getX());
            f.addProperty("y", cookingPos.getY());
            f.addProperty("z", cookingPos.getZ());
            f.addProperty("remainingSec", runner.activeSmeltRemainingTicks((int) tick) / 20);
            root.add("activeFurnace", f);
        }

        // Inventory counts
        JsonObject inv = new JsonObject();
        var pinv = player.getInventory();
        for (int i = 0; i < pinv.size(); i++) {
            ItemStack st = pinv.getStack(i);
            if (st.isEmpty()) continue;
            String id = Registries.ITEM.getId(st.getItem()).getPath();
            inv.addProperty(id, st.getCount() + (inv.has(id) ? inv.get(id).getAsInt() : 0));
        }
        root.add("inventory", inv);

        // Active & queued tasks
        TaskRunner.Task active = runner.activeTask();
        if (active != null) {
            root.add("activeTask", taskJson(active));
        }
        JsonArray q = new JsonArray();
        for (TaskRunner.Task t : runner.queuedTasks()) q.add(taskJson(t));
        root.add("queuedTasks", q);

        // Recent receipts
        JsonArray receipts = new JsonArray();
        for (TaskRunner.TaskReceipt r : runner.recentReceipts()) {
            JsonObject ro = new JsonObject();
            ro.addProperty("id", r.id());
            ro.addProperty("kind", r.kind());
            ro.addProperty("target", r.target());
            ro.addProperty("outcome", r.outcome());
            ro.addProperty("detail", r.detail());
            ro.addProperty("tick", r.tick());
            receipts.add(ro);
        }
        root.add("recentReceipts", receipts);

        // Observed environment summary
        BlockPos feet = player.getBlockPos();
        JsonObject env = new JsonObject();
        env.addProperty("visibleLogs", perception.observedLogs().size());
        env.addProperty("visibleStone", perception.observedStone().size());
        env.addProperty("visibleWater", perception.observedWater().size());
        env.addProperty("visibleLava", perception.observedLava().size());
        env.addProperty("visibleBerries", perception.observedBerries().size());
        env.addProperty("visibleHostiles", perception.visibleHostiles().size());
        env.addProperty("visibleFoodAnimals", perception.visibleFoodAnimals().size());
        env.addProperty("visibleDrops", perception.visibleDrops().size());
        env.addProperty("nearbyTables", perception.observedTables().size());
        env.addProperty("nearbyFurnaces", perception.observedFurnaces().size());

        // Nearest ore targets (observed, or diagnostic targets if explicitly enabled!)
        JsonObject ores = new JsonObject();
        ores.add("coal", oreArray(perception.nearestOreTargets(Perception.OreKind.COAL, feet, 3, null), feet));
        ores.add("iron", oreArray(perception.nearestOreTargets(Perception.OreKind.IRON, feet, 3, null), feet));
        ores.add("diamond", oreArray(perception.nearestOreTargets(Perception.OreKind.DIAMOND, feet, 3, null), feet));
        env.add("ores", ores);
        root.add("environment", env);

        if (!lastAppliedPlanId.isEmpty()) {
            JsonObject app = new JsonObject();
            app.addProperty("planId", lastAppliedPlanId);
            app.addProperty("tick", lastAppliedTick);
            root.add("appliedPlan", app);
        }

        pendingStateJson.set(root.toString());
    }

    IncomingPlan pollNewPlan(long currentTick) {
        IncomingPlan p = incomingPlan.getAndSet(null);
        if (p == null || p.planId().equals(lastAppliedPlanId)) return null;
        lastAppliedPlanId = p.planId();
        lastAppliedRationale = p.rationale();
        lastAppliedTick = currentTick;
        return p;
    }

    String lastAppliedPlanId() { return lastAppliedPlanId; }
    String lastAppliedRationale() { return lastAppliedRationale; }

    void close() {
        closed = true;
        io.execute(this::exchange);
        io.shutdown();
    }

    private void exchange() {
        String state = pendingStateJson.getAndSet(null);
        if (state != null) {
            try {
                Path tmp = Files.createTempFile(dir, ".state-", ".tmp",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                try {
                    Files.writeString(tmp, state + "\n", StandardCharsets.UTF_8);
                    Files.move(tmp, stateFile, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                } finally {
                    Files.deleteIfExists(tmp);
                }
            } catch (IOException ignored) {}
        }

        if (Files.isRegularFile(planFile, LinkOption.NOFOLLOW_LINKS)) {
            try {
                String raw = Files.readString(planFile, StandardCharsets.UTF_8);
                IncomingPlan parsed = parsePlan(raw);
                if (parsed != null && !parsed.planId().equals(lastAppliedPlanId)) {
                    incomingPlan.set(parsed);
                }
            } catch (IOException | RuntimeException ignored) {}
        }
    }

    private IncomingPlan parsePlan(String raw) {
        JsonObject obj = JsonParser.parseString(raw).getAsJsonObject();
        if (!runId.equals(str(obj, "run"))) return null;
        String planId = str(obj, "planId");
        if (planId.isEmpty()) return null;
        String rationale = str(obj, "rationale");
        boolean replace = obj.has("replaceQueue") && obj.get("replaceQueue").getAsBoolean();
        Boolean safeMode = null;
        if (obj.has("excavationMode") && !obj.get("excavationMode").isJsonNull()) {
            String m = obj.get("excavationMode").getAsString();
            if ("safe_staircase".equals(m)) safeMode = true;
            else if ("fast".equals(m)) safeMode = false;
        }
        List<TaskRunner.Task> tasks = new ArrayList<>();
        if (obj.has("tasks") && obj.get("tasks").isJsonArray()) {
            int idx = 0;
            for (JsonElement el : obj.getAsJsonArray("tasks")) {
                if (!el.isJsonObject()) continue;
                JsonObject to = el.getAsJsonObject();
                TaskRunner.TaskKind kind = parseKind(str(to, "kind"));
                if (kind == null) continue;
                String target = str(to, "target");
                int count = to.has("count") && to.get("count").isJsonPrimitive() ? to.get("count").getAsInt() : 1;
                BlockPos pos = null;
                if (to.has("x") && to.has("y") && to.has("z")
                        && !to.get("x").isJsonNull() && !to.get("y").isJsonNull() && !to.get("z").isJsonNull()) {
                    pos = new BlockPos(to.get("x").getAsInt(), to.get("y").getAsInt(), to.get("z").getAsInt());
                }
                boolean safe = safeMode != null ? safeMode : true;
                tasks.add(new TaskRunner.Task(planId + "-" + (++idx), kind, target, count, pos, safe, "model"));
            }
        }
        return new IncomingPlan(planId, rationale, replace, safeMode, tasks);
    }

    private static TaskRunner.TaskKind parseKind(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            return TaskRunner.TaskKind.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String str(JsonObject o, String key) {
        return o.has(key) && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : "";
    }

    private static JsonObject taskJson(TaskRunner.Task t) {
        JsonObject o = new JsonObject();
        o.addProperty("id", t.id());
        o.addProperty("kind", t.kind().name().toLowerCase());
        o.addProperty("target", t.target());
        o.addProperty("count", t.count());
        o.addProperty("source", t.source());
        if (t.pos() != null) {
            JsonArray p = new JsonArray(3);
            p.add(t.pos().getX());
            p.add(t.pos().getY());
            p.add(t.pos().getZ());
            o.add("pos", p);
        }
        return o;
    }

    private static JsonArray oreArray(List<BlockPos> list, BlockPos from) {
        JsonArray arr = new JsonArray();
        for (BlockPos bp : list) {
            JsonObject o = new JsonObject();
            o.addProperty("x", bp.getX());
            o.addProperty("y", bp.getY());
            o.addProperty("z", bp.getZ());
            o.addProperty("dist", Math.round(Math.sqrt(bp.getSquaredDistance(from))));
            arr.add(o);
        }
        return arr;
    }
}
