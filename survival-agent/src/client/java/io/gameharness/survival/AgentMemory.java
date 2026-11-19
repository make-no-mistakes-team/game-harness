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
final class AgentMemory {
    private static final int MAX_BYTES = 32 * 1024;
    static final int MAX_CELLS = 1024;
    private static final long SAVE_INTERVAL = 750_000_000L;
    private static final String DIMENSION = "minecraft:overworld";
    private static final Set<PosixFilePermission> PRIVATE_PERMISSIONS = PosixFilePermissions.fromString("rw-------");

    private record Snapshot(List<BlockPos> trail, List<BlockPos> dormant, BlockPos workbench, BlockPos furnace) {}
    record Rejoin(List<BlockPos> prefix, int activeIndex, int resumeAt) {}
    private static final Snapshot EMPTY = new Snapshot(List.of(), List.of(), null, null);
    private final Path file;
    private Snapshot saved;
    private List<BlockPos> parentTrail;
    private List<BlockPos> dormant;
    private boolean attached;
    private ClientWorld overworld;
    private BlockPos workbench;
    private BlockPos furnace;
    private boolean inheritedWorkbench, inheritedFurnace;
    private boolean localWorkbench, localFurnace;
    private boolean joined;
    private BlockPos detachedAt;
    private BlockPos observedTip, landing;
    private long leftTip, contactTick;
    private int groundedContacts;
    private int waitForGround;
    private long lastSave = System.nanoTime() - SAVE_INTERVAL;

    AgentMemory(Path directory) {
        file = directory.resolve("agent-memory.json");
        saved = read();
        parentTrail = saved.trail;
        dormant = saved.dormant;
        workbench = saved.workbench;
        furnace = saved.furnace;
        inheritedWorkbench = workbench != null;
        inheritedFurnace = furnace != null;
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
        localWorkbench = nearby(workbench, eye);
        localFurnace = nearby(furnace, eye);
        if (!parentTrail.contains(standing)) return List.of();
        List<BlockPos> trail = parentTrail;
        parentTrail = List.of();
        joined = true;
        return trail;
    }

    private static boolean nearby(BlockPos position, Vec3d eye) {
        return position != null && eye.squaredDistanceTo(Vec3d.ofCenter(position)) <= 20.25;
    }

    Rejoin rejoin(ClientWorld world, BlockPos standing, List<BlockPos> trail, boolean routing) {
        if (world != overworld || parentTrail.isEmpty() && dormant.isEmpty()) return null;
        if (standing.equals(detachedAt)) return null;
        detachedAt = null;
        int activeIndex = trail.lastIndexOf(standing);
        // Preserve in-flight return/resume targets: root prepends only while routing.
        if (routing && activeIndex != 0) return null;
        int dormantIndex = dormant.indexOf(standing);
        Rejoin match = !routing && trail.size() <= 1 && dormantIndex >= 0
            ? new Rejoin(dormant, activeIndex, dormantIndex + 1) : splice(dormant, standing, trail, activeIndex);
        if (match == null) match = splice(parentTrail, standing, trail, activeIndex);
        if (match == null) return null;
        parentTrail = dormant = List.of();
        joined = true;
        return match;
    }

    private static Rejoin splice(List<BlockPos> known, BlockPos standing, List<BlockPos> trail, int activeIndex) {
        int join = known.indexOf(standing);
        if (join < 0 || join <= activeIndex && activeIndex >= 0) return null;
        int suffixStart = activeIndex < 0 ? trail.size() : activeIndex + 1;
        int prefixSize = join + 1;
        if (prefixSize + trail.size() - suffixStart > MAX_CELLS) return null;
        List<BlockPos> prefix = known.subList(0, prefixSize);
        // The new route must be a single path; only its join may be shared.
        for (int i = suffixStart; i < trail.size(); i++) {
            if (prefix.contains(trail.get(i))) return null;
        }
        return new Rejoin(prefix, activeIndex, -1);
    }

    void detach(ClientWorld world, List<BlockPos> trail, BlockPos standing) {
        if (world != overworld || trail.size() < 2) return;
        int start = connectedStart(trail);
        if (trail.size() - start < 2) return;
        List<BlockPos> connected = new ArrayList<>(trail.size() - start);
        for (int i = start; i < trail.size(); i++) {
            BlockPos cell = trail.get(i);
            int revisit = connected.indexOf(cell);
            if (revisit < 0) connected.add(cell);
            else connected.subList(revisit + 1, connected.size()).clear();
        }
        if (connected.size() < 2) return;
        dormant = connected;
        detachedAt = standing;
    }

    static final class Excursion {
        private static final int LIMIT = 32;
        private final List<BlockPos> walked = new ArrayList<>(LIMIT);
        private long contactTick;
        private boolean disconnected;

        void clear() {
            walked.clear();
            disconnected = false;
        }

        void observe(BlockPos entry, BlockPos standing, long tick, boolean extending) {
            if (!walked.isEmpty() && !entry.equals(walked.getFirst())) clear();
            if (walked.isEmpty()) {
                if (!standing.equals(entry)) return;
                walked.add(entry);
            } else if (!standing.equals(walked.getLast())) {
                int existing = walked.lastIndexOf(standing);
                if (existing >= 0) {
                    walked.subList(existing + 1, walked.size()).clear();
                    disconnected = false;
                } else if (extending && !disconnected) {
                    BlockPos prior = walked.getLast();
                    int dx = Math.abs(prior.getX() - standing.getX()), dz = Math.abs(prior.getZ() - standing.getZ());
                    if (dx > 1 || dz > 1 || Math.abs(prior.getY() - standing.getY()) > 1
                        || tick - contactTick > 14 || walked.size() == LIMIT) disconnected = true;
                    else walked.add(standing);
                } else return;
            }
            contactTick = tick;
        }

        boolean started() { return !walked.isEmpty(); }

        BlockPos previous(BlockPos standing) {
            for (int i = walked.lastIndexOf(standing) - 1; i >= 0; i--) {
                BlockPos step = walked.get(i);
                // A jump or a lip can produce two contacts in the same column.
                // Never drive toward a different height with no walking bearing.
                if (step.getX() != standing.getX() || step.getZ() != standing.getZ()) return step;
            }
            return null;
        }
    }

    void observeLanding(ClientWorld world, List<BlockPos> trail, BlockPos feet, boolean grounded, long tick) {
        BlockPos tip = world == overworld && !trail.isEmpty() ? trail.getLast() : null;
        if (tip == null || !adjacentColumn(tip, feet) || Math.abs((long) tip.getY() - feet.getY()) > 2) {
            observedTip = landing = null;
            return;
        }
        if (grounded && tip.equals(feet)) {
            observedTip = tip;
            leftTip = tick;
            landing = null;
        } else if (!grounded || !tip.equals(observedTip) || !adjacent(tip, feet)
            || tip.getX() == feet.getX() && tip.getZ() == feet.getZ()) {
            landing = null;
        } else if (feet.equals(landing) && tick == contactTick + 1) {
            groundedContacts = Math.min(3, groundedContacts + 1);
            contactTick = tick;
        } else if (tick - leftTip <= 10) {
            landing = feet;
            groundedContacts = 1;
            contactTick = tick;
        } else {
            landing = null;
        }
    }

    BlockPos station(ClientWorld world, boolean isFurnace) {
        if (world != overworld) return null;
        if (isFurnace) return inheritedFurnace && (joined || localFurnace) ? furnace : null;
        return inheritedWorkbench && (joined || localWorkbench) ? workbench : null;
    }

    void confirm(ClientWorld world, boolean isFurnace, BlockPos position) {
        if (world != overworld || !valid(position)) return;
        if (isFurnace) {
            furnace = position;
            inheritedFurnace = false;
        } else {
            workbench = position;
            inheritedWorkbench = false;
        }
    }

    void forget(ClientWorld world, boolean isFurnace, BlockPos position) {
        if (world != overworld) return;
        if (isFurnace && position.equals(furnace)) furnace = null;
        else if (!isFurnace && position.equals(workbench)) workbench = null;
    }

    void save(ClientWorld world, List<BlockPos> trail, boolean force) {
        if (world == null || world != overworld) return;
        long now = System.nanoTime();
        if (!force && now - lastSave < SAVE_INTERVAL) return;
        lastSave = now;
        int start = connectedStart(trail);
        int length = trail.size() - start;
        // A last walking step can land after the miner's final update. The player's
        // own consecutive contacts, not a planned next step, prove this one edge.
        BlockPos extra = length > 0 && length < MAX_CELLS && groundedContacts >= 3 && landing != null
            && trail.getLast().equals(observedTip) && valid(landing) && !trail.contains(landing) ? landing : null;
        if (length == 0 && !parentTrail.isEmpty()) {
            trail = parentTrail;
            start = 0;
            length = trail.size();
        }
        List<BlockPos> inactive = !dormant.isEmpty() ? dormant : trail == parentTrail ? List.of() : parentTrail;
        int activeLength = length + (extra == null ? 0 : 1);
        int dormantLength = Math.min(inactive.size(), MAX_CELLS - activeLength);
        if (dormantLength < 2) dormantLength = 0;
        if (sameTrail(saved.trail, trail, start, length, extra) && sameTrail(saved.dormant, inactive, 0, dormantLength, null)
            && Objects.equals(workbench, saved.workbench)
            && Objects.equals(furnace, saved.furnace)) return;
        StringBuilder json = new StringBuilder(96 + (activeLength + dormantLength) * 14);
        json.append("{\"version\":1,\"dimension\":\"").append(DIMENSION).append("\",\"trail\":");
        encodeTrail(json, trail, start, length, extra);
        if (dormantLength > 0) encodeTrail(json.append(",\"dormant\":"), inactive, 0, dormantLength, null);
        if (workbench != null) encode(json.append(",\"workbench\":"), workbench);
        if (furnace != null) encode(json.append(",\"furnace\":"), furnace);
        json.append('}');
        Path tmp = null;
        try {
            tmp = Files.createTempFile(file.getParent(), "agent-memory-", ".tmp",
                PosixFilePermissions.asFileAttribute(PRIVATE_PERMISSIONS));
            Files.setPosixFilePermissions(tmp, PRIVATE_PERMISSIONS);
            Files.writeString(tmp, json);
            Files.move(tmp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            List<BlockPos> recorded = trail.subList(start, start + length);
            if (extra != null) {
                var extended = new ArrayList<BlockPos>(activeLength);
                extended.addAll(recorded);
                extended.add(extra);
                recorded = extended;
            } else recorded = List.copyOf(recorded);
            saved = new Snapshot(recorded,
                List.copyOf(inactive.subList(0, dormantLength)), workbench, furnace);
        } catch (IOException ignored) {
            // Optional memory must not interrupt play or emit recorded positions.
        } finally {
            if (tmp != null) try { Files.deleteIfExists(tmp); } catch (IOException ignored) {}
        }
    }

    private static int connectedStart(List<BlockPos> trail) {
        // A bad join is not a route. Retain only the connected suffix.
        int start = Math.max(0, trail.size() - MAX_CELLS);
        for (int i = trail.size() - 1; i >= start; i--) {
            BlockPos cell = trail.get(i);
            if (!valid(cell)) return i + 1;
            if (i > start && !adjacent(trail.get(i - 1), cell)) return i;
        }
        return start;
    }

    private static boolean sameTrail(List<BlockPos> expected, List<BlockPos> trail, int start, int length, BlockPos extra) {
        if (length + (extra == null ? 0 : 1) != expected.size() || extra != null && !extra.equals(expected.getLast()))
            return false;
        for (int i = 0; i < length; i++) {
            if (!expected.get(i).equals(trail.get(start + i))) return false;
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
                    || object.size() != 3 + (object.has("dormant") ? 1 : 0) + (object.has("workbench") ? 1 : 0)
                        + (object.has("furnace") ? 1 : 0))
                    return EMPTY;
                List<BlockPos> cells = decodeTrail(object.getAsJsonArray("trail"), MAX_CELLS);
                List<BlockPos> inactive = object.has("dormant")
                    ? decodeTrail(object.getAsJsonArray("dormant"), MAX_CELLS - cells.size()) : List.of();
                return new Snapshot(cells, inactive, object.has("workbench") ? decode(object.get("workbench")) : null,
                    object.has("furnace") ? decode(object.get("furnace")) : null);
            }
        } catch (IOException | RuntimeException ignored) {
            return EMPTY;
        }
    }

    private static List<BlockPos> decodeTrail(JsonArray route, int limit) {
        if (route.size() > limit) throw new IllegalArgumentException();
        List<BlockPos> cells = new ArrayList<>(route.size());
        var seen = new HashSet<BlockPos>();
        for (JsonElement entry : route) {
            BlockPos cell = decode(entry);
            if (!seen.add(cell) || !cells.isEmpty() && !adjacent(cells.getLast(), cell)) throw new IllegalArgumentException();
            cells.add(cell);
        }
        return cells;
    }

    private static boolean valid(BlockPos p) {
        return p.getX() >= -30_000_000 && p.getX() <= 30_000_000 && p.getY() >= -64 && p.getY() <= 320
            && p.getZ() >= -30_000_000 && p.getZ() <= 30_000_000;
    }

    private static boolean adjacent(BlockPos a, BlockPos b) {
        return Math.abs((long) a.getY() - b.getY()) <= 1 && adjacentColumn(a, b);
    }

    private static boolean adjacentColumn(BlockPos a, BlockPos b) {
        return Math.abs((long) a.getX() - b.getX()) + Math.abs((long) a.getZ() - b.getZ()) <= 1;
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

    private static void encodeTrail(StringBuilder json, List<BlockPos> trail, int start, int length, BlockPos extra) {
        json.append('[');
        for (int i = 0; i < length; i++) {
            if (i > 0) json.append(',');
            encode(json, trail.get(start + i));
        }
        if (extra != null) {
            if (length > 0) json.append(',');
            encode(json, extra);
        }
        json.append(']');
    }
}
