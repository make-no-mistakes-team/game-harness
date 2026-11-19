package io.gameharness.pilot;

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
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.World;

/** Continuations carry observations, never unfinished actions. */
final class PilotMemory {
    private static final int MAX_BYTES = 32 * 1024;
    private static final int MAX_CELLS = 1024;
    private static final long SAVE_INTERVAL = 750_000_000L;
    private static final String DIMENSION = "minecraft:overworld";
    private static final Set<PosixFilePermission> PRIVATE_PERMISSIONS = PosixFilePermissions.fromString("rw-------");

    private record Snapshot(List<BlockPos> trail, BlockPos workbench, BlockPos furnace) {}
    private static final Snapshot EMPTY = new Snapshot(List.of(), null, null);
    private final Path file;
    private Snapshot saved;
    private boolean attached;
    private ClientWorld overworld;
    private BlockPos workbench;
    private BlockPos furnace;
    private BlockPos inheritedWorkbench;
    private BlockPos inheritedFurnace;
    private int waitForGround;
    private long lastSave = System.nanoTime() - SAVE_INTERVAL;

    PilotMemory(Path directory) {
        file = directory.resolve("pilot-memory.json");
        saved = read();
    }

    boolean attach(ClientWorld world, boolean grounded) {
        if (attached) return true;
        if (World.OVERWORLD.equals(world.getRegistryKey())) {
            if (saved != EMPTY && !grounded && ++waitForGround <= 20) return false;
            overworld = world;
        }
        attached = true;
        return true;
    }

    List<BlockPos> restore(ClientWorld world, BlockPos standing, Vec3d eye) {
        if (world != overworld || standing == null) return List.of();
        List<BlockPos> trail = saved.trail.contains(standing) ? saved.trail : List.of();
        workbench = inheritedWorkbench = localHint(saved.workbench, trail, eye);
        furnace = inheritedFurnace = localHint(saved.furnace, trail, eye);
        return trail;
    }

    private static BlockPos localHint(BlockPos position, List<BlockPos> trail, Vec3d eye) {
        return position != null && (!trail.isEmpty() || eye.squaredDistanceTo(Vec3d.ofCenter(position)) <= 20.25)
            ? position : null;
    }

    BlockPos station(ClientWorld world, boolean isFurnace) {
        return world == overworld ? (isFurnace ? inheritedFurnace : inheritedWorkbench) : null;
    }

    void confirm(ClientWorld world, boolean isFurnace, BlockPos position) {
        if (world != overworld || !valid(position)) return;
        if (isFurnace) {
            furnace = position;
            inheritedFurnace = null;
        } else {
            workbench = position;
            inheritedWorkbench = null;
        }
    }

    void forget(ClientWorld world, boolean isFurnace, BlockPos position) {
        if (world != overworld) return;
        if (isFurnace && position.equals(furnace)) furnace = inheritedFurnace = null;
        else if (!isFurnace && position.equals(workbench)) workbench = inheritedWorkbench = null;
    }

    void save(ClientWorld world, List<BlockPos> trail, boolean force) {
        if (world == null || world != overworld) return;
        long now = System.nanoTime();
        if (!force && now - lastSave < SAVE_INTERVAL) return;
        lastSave = now;
        int start = Math.max(0, trail.size() - MAX_CELLS);
        // A bad join is not a route. Retain only the connected suffix.
        for (int i = trail.size() - 1; i >= start; i--) {
            BlockPos cell = trail.get(i);
            if (!valid(cell)) { start = i + 1; break; }
            if (i > start && !adjacent(trail.get(i - 1), cell)) { start = i; break; }
        }
        int length = trail.size() - start;
        if (sameTrail(trail, start, length) && Objects.equals(workbench, saved.workbench)
            && Objects.equals(furnace, saved.furnace)) return;
        StringBuilder json = new StringBuilder(96 + length * 14);
        json.append("{\"version\":1,\"dimension\":\"").append(DIMENSION).append("\",\"trail\":[");
        for (int i = start; i < trail.size(); i++) {
            if (i > start) json.append(',');
            encode(json, trail.get(i));
        }
        json.append(']');
        if (workbench != null) encode(json.append(",\"workbench\":"), workbench);
        if (furnace != null) encode(json.append(",\"furnace\":"), furnace);
        json.append('}');
        Path tmp = null;
        try {
            tmp = Files.createTempFile(file.getParent(), "pilot-memory-", ".tmp",
                PosixFilePermissions.asFileAttribute(PRIVATE_PERMISSIONS));
            Files.setPosixFilePermissions(tmp, PRIVATE_PERMISSIONS);
            Files.writeString(tmp, json);
            Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            saved = new Snapshot(List.copyOf(trail.subList(start, trail.size())), workbench, furnace);
        } catch (IOException ignored) {
            // Optional memory must not interrupt play or emit recorded positions.
        } finally {
            if (tmp != null) try { Files.deleteIfExists(tmp); } catch (IOException ignored) {}
        }
    }

    private boolean sameTrail(List<BlockPos> trail, int start, int length) {
        if (length != saved.trail.size()) return false;
        for (int i = 0; i < length; i++) {
            if (!saved.trail.get(i).equals(trail.get(start + i))) return false;
        }
        return true;
    }

    private Snapshot read() {
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                || !Files.getPosixFilePermissions(file, LinkOption.NOFOLLOW_LINKS).equals(PRIVATE_PERMISSIONS))
                return EMPTY;
            try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
                byte[] bytes = input.readNBytes(MAX_BYTES + 1);
                if (bytes.length == 0 || bytes.length > MAX_BYTES) return EMPTY;
                JsonObject object = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
                JsonElement dimension = object.get("dimension");
                if (integer(object.get("version")) != 1 || !dimension.isJsonPrimitive()
                    || !dimension.getAsJsonPrimitive().isString() || !DIMENSION.equals(dimension.getAsString())
                    || object.size() != 3 + (object.has("workbench") ? 1 : 0) + (object.has("furnace") ? 1 : 0))
                    return EMPTY;
                JsonArray route = object.getAsJsonArray("trail");
                if (route.size() > MAX_CELLS) return EMPTY;
                List<BlockPos> cells = new ArrayList<>(route.size());
                var seen = new HashSet<BlockPos>();
                for (JsonElement entry : route) {
                    BlockPos cell = decode(entry);
                    if (!seen.add(cell) || !cells.isEmpty() && !adjacent(cells.getLast(), cell)) return EMPTY;
                    cells.add(cell);
                }
                return new Snapshot(cells, object.has("workbench") ? decode(object.get("workbench")) : null,
                    object.has("furnace") ? decode(object.get("furnace")) : null);
            }
        } catch (IOException | RuntimeException ignored) {
            return EMPTY;
        }
    }

    private static boolean valid(BlockPos p) {
        return p.getX() >= -30_000_000 && p.getX() <= 30_000_000 && p.getY() >= -64 && p.getY() <= 320
            && p.getZ() >= -30_000_000 && p.getZ() <= 30_000_000;
    }

    private static boolean adjacent(BlockPos a, BlockPos b) {
        return Math.abs((long) a.getY() - b.getY()) <= 1
            && Math.abs((long) a.getX() - b.getX()) + Math.abs((long) a.getZ() - b.getZ()) <= 1;
    }

    private static int integer(JsonElement value) {
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) throw new IllegalArgumentException();
        return value.getAsBigDecimal().intValueExact();
    }

    private static BlockPos decode(JsonElement value) {
        JsonArray p = value.getAsJsonArray();
        if (p.size() != 3) throw new IllegalArgumentException();
        BlockPos result = new BlockPos(integer(p.get(0)), integer(p.get(1)), integer(p.get(2)));
        if (!valid(result)) throw new IllegalArgumentException();
        return result;
    }

    private static void encode(StringBuilder json, BlockPos p) {
        json.append('[').append(p.getX()).append(',').append(p.getY()).append(',').append(p.getZ()).append(']');
    }
}
