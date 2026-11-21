package io.gameharness.survival;

import com.google.gson.Gson;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import net.minecraft.item.Item;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;

/** One paid world obligation. This module observes no world, slots, inputs or player stock. */
final class AgentPendingFurnaceMemory {
    enum State { PAID, PARKED, COLLECTED, CANCELLED, DISAPPEARED }
    private enum Basis { LIVE, RESUME, CLUE }
    private record Scope(int v, String run, String world, String resume) {}
    private record Stamp(String run, int life, long tick, long frame) {}
    private record Close(int v, Stamp stamp, String id, String record, AgentWalkedRoute.Breadcrumbs breadcrumbs) {}
    private record Floor(String item, int count) {}
    private record Wire(int v, String run, String world, String owner, String id, String originId, String originWorld,
                        String dimension, int[] pos, int[] footing, String facing, String raw, int units, String fuel,
                        int fuelCount, int fuelTicks, String output, int syncId, int minimumOutput, int maximumFuel,
                        String basis, String state, Stamp paid, Stamp parked, Stamp lost, Stamp gone, Stamp ended,
                        Floor[] floors, AgentWalkedRoute.Breadcrumbs breadcrumbs, Boolean ordinary) {
        Wire with(Basis basis, State state, Stamp parked, Stamp lost, Stamp gone, Stamp ended) {
            return new Wire(v, run, world, owner, id, originId, originWorld, dimension, pos, footing, facing,
                raw, units, fuel, fuelCount, fuelTicks, output, syncId, minimumOutput, maximumFuel,
                key(basis), key(state), paid, parked, lost, gone, ended, floors, null, ordinary);
        }

        Stamp latest() {
            return ended != null ? ended : gone != null ? gone : lost != null ? lost : parked != null ? parked : paid;
        }
    }

    static final class Entry {
        private final Wire row;
        private final AgentHands.IronBatch batch;
        private final AgentLocalSmelt.Batch ordinaryBatch;
        private final BlockPos pos, footing;
        private final Direction facing;
        private final Map<Item, Integer> floors;
        private final UUID ticket;
        private final State state;
        private final Basis basis;

        private Entry(Wire row, AgentHands.IronBatch batch) {
            this.row = row;
            this.batch = batch;
            ordinaryBatch = Boolean.TRUE.equals(row.ordinary)
                ? new AgentLocalSmelt.Batch(knownItem(row.raw), row.units, row.minimumOutput) : null;
            pos = fromCell(row.pos);
            footing = fromCell(row.footing);
            facing = Direction.valueOf(row.facing.toUpperCase(Locale.ROOT));
            ticket = UUID.fromString(row.id);
            state = State.valueOf(row.state.toUpperCase(Locale.ROOT));
            basis = Basis.valueOf(row.basis.toUpperCase(Locale.ROOT));
            floors = readFloors(row.floors);
        }

        UUID ticket() { return ticket; }
        String dimension() { return row.dimension; }
        BlockPos pos() { return pos; }
        BlockPos footing() { return footing; }
        Direction facing() { return facing; }
        AgentHands.IronBatch batch() { return batch; }
        AgentLocalSmelt.Batch ordinaryBatch() { return ordinaryBatch; }
        int minimumOutput() { return row.minimumOutput; }
        int maximumFuel() { return row.maximumFuel; }
        int syncId() { return row.syncId; }
        State state() { return state; }
        Map<Item, Integer> floors() { return floors; }
        AgentWalkedRoute.Breadcrumbs breadcrumbs() { return basis == Basis.RESUME ? row.breadcrumbs : null; }
        boolean historical() { return basis != Basis.LIVE; }
        boolean mayInvestigateCollection() { return basis != Basis.CLUE && (state == State.PAID || state == State.PARKED); }
    }

    private static final Gson JSON = new Gson();
    // 32 longest vanilla reserve IDs plus 36 signed coordinate pairs, with stamp/header room.
    private static final int BYTES = 8_192;
    private static final long MAX_NUMBER = 9_007_199_254_740_991L;
    private static final Pattern HASH = Pattern.compile("[a-f0-9]{64}");
    private static final Pattern VANILLA_ITEM = Pattern.compile("minecraft:[a-z0-9_]{1,96}");
    private static final Set<PosixFilePermission> PRIVATE_MODE = PosixFilePermissions.fromString("rw-------");
    private static final Set<String> DIMENSIONS = Set.of("minecraft:overworld", "minecraft:the_nether", "minecraft:the_end");
    private static final String SCOPE = "pending-furnace-scope.json";
    private static final String RECORD = "pending-furnace.json";
    private static final String TEMP = "pending-furnace.tmp";
    private static final String CLOSE = "pending-furnace-close.json";
    private static final String RAW = "minecraft:raw_iron";
    private static final String OUTPUT = "minecraft:iron_ingot";
    private final Path directory;
    private Scope scope;
    private Entry entry;
    private String committedText;
    private UUID owner;
    private int life;
    private boolean bound, failed;

    AgentPendingFurnaceMemory(Path directory) { this.directory = directory; }

    boolean bind(UUID owner, int life, long tick, long frame) {
        if (owner == null || life < 1 || failed) return false;
        if (bound) {
            if (!owner.equals(this.owner) || life < this.life) return false;
            boolean newLife = life > this.life;
            this.life = life;
            if (newLife) discontinuity(tick, frame);
            return scope != null && !failed;
        }
        bound = true;
        this.owner = owner;
        this.life = life;
        try {
            scope = JSON.fromJson(read(SCOPE), Scope.class);
            if (scope.v != 1 || !directory.getFileName().toString().equals(scope.run) ||
                    !validUuid(scope.world) || (scope.resume != null && !HASH.matcher(scope.resume).matches())) {
                scope = null;
                return false;
            }
            if (scope.resume == null) {
                // A new process cannot resume a previous actor in the same run directory.
                if (!Files.notExists(directory.resolve(RECORD), LinkOption.NOFOLLOW_LINKS)) scope = null;
                return scope != null;
            }
            String text = read(RECORD);
            if (!scope.resume.equals(digest(text))) throw new IllegalArgumentException();
            Wire row = JSON.fromJson(text, Wire.class);
            if (row.v != 1 || !scope.run.equals(row.run) || !scope.world.equals(row.world) ||
                    !owner.toString().equals(row.owner) || !validUuid(row.id) || !validUuid(row.originId) ||
                    row.id.equals(row.originId) || !validUuid(row.originWorld) || row.originWorld.equals(row.world) ||
                    row.paid == null || row.run.equals(row.paid.run) || !("resume".equals(row.basis) || "clue".equals(row.basis)))
                throw new IllegalArgumentException();
            AgentHands.IronBatch batch = null;
            if (row.ordinary == null) {
                if (!RAW.equals(row.raw) || !OUTPUT.equals(row.output)) throw new IllegalArgumentException();
                batch = new AgentHands.IronBatch(row.units, knownItem(row.fuel), row.fuelCount, row.fuelTicks);
                if (!validBatch(batch, row.minimumOutput, row.maximumFuel)) throw new IllegalArgumentException();
            } else if (!row.ordinary || row.fuel != null || row.fuelCount != 0 || row.fuelTicks != 0
                    || row.maximumFuel != 0 || row.floors != null || !validOrdinary(knownItem(row.raw), row.units, row.minimumOutput)
                    || !row.output.equals(itemId(AgentLocalSmelt.result(knownItem(row.raw))))) {
                throw new IllegalArgumentException();
            }
            Entry restored = new Entry(row, batch);
            if (!validStation(row.dimension, restored.pos, restored.footing, restored.facing)
                    || !validSync(row.syncId) || restored.state == State.COLLECTED ||
                    restored.state == State.CANCELLED || restored.state == State.DISAPPEARED && restored.basis != Basis.CLUE)
                throw new IllegalArgumentException();
            if (row.breadcrumbs != null && (restored.basis != Basis.RESUME ||
                    !AgentWalkedRoute.validBreadcrumbs(row.breadcrumbs, restored.pos.getX(), restored.pos.getY(), restored.pos.getZ())))
                throw new IllegalArgumentException();
            entry = restored;
            committedText = text;
            if (life != 1) discontinuity(tick, frame);
            return !failed;
        } catch (IOException | RuntimeException ignored) {
            scope = null;
            return false;
        }
    }

    Entry current() {
        return entry == null || entry.state == State.COLLECTED || entry.state == State.CANCELLED ? null : entry;
    }

    boolean pay(UUID ticket, String dimension, BlockPos pos, Direction facing, BlockPos footing,
                AgentHands.IronBatch batch, int syncId, int visibleOutput, int visibleFuel, Map<Item, Integer> floors,
                long tick, long frame) {
        Stamp stamp = stamp(tick, frame);
        if (stamp == null || frame == 0 || ticket == null || !validSync(syncId) ||
                !validBatch(batch, visibleOutput, visibleFuel) || !validStation(dimension, pos, footing, facing)
                || floors == null || floors.size() > 32) return false;
        if (entry != null) {
            if (entry.ticket.equals(ticket))
                return entry.state == State.PAID && entry.basis == Basis.LIVE && stamp.equals(entry.row.paid)
                    && entry.pos.equals(pos) && entry.footing.equals(footing) && entry.dimension().equals(dimension)
                    && entry.facing == facing && batch.equals(entry.batch) && entry.syncId() == syncId
                    && entry.minimumOutput() == visibleOutput && entry.maximumFuel() == visibleFuel
                    && entry.floors.equals(floors);
            if (current() != null || !atOrAfter(stamp, entry.row.latest())) return false;
        }
        Floor[] restrictions = new Floor[floors.size()];
        int i = 0;
        for (var floor : floors.entrySet()) {
            if (floor.getKey() == null || floor.getKey() == Items.AIR || floor.getValue() == null
                    || floor.getValue() < 1 || floor.getValue() > 2_304) return false;
            String item = Registries.ITEM.getId(floor.getKey()).toString();
            if (!VANILLA_ITEM.matcher(item).matches()) return false;
            restrictions[i++] = new Floor(item, floor.getValue());
        }
        return store(new Wire(1, scope.run, scope.world, owner.toString(), ticket.toString(), ticket.toString(), scope.world,
            dimension, cell(pos), cell(footing), key(facing), RAW, batch.units(), Registries.ITEM.getId(batch.fuel()).toString(),
            batch.fuelCount(), batch.fuelTicks(), OUTPUT, syncId, visibleOutput, visibleFuel, "live", "paid",
            stamp, null, null, null, null, restrictions, null, null), batch);
    }

    boolean payOrdinary(UUID ticket, String dimension, BlockPos pos, Direction facing, BlockPos footing,
                        AgentLocalSmelt.Batch batch, int syncId, long tick, long frame) {
        Stamp stamp = stamp(tick, frame);
        if (stamp == null || frame == 0 || ticket == null || !validSync(syncId)
                || !validStation(dimension, pos, footing, facing) || !validOrdinary(batch.raw(), batch.units(), batch.minimumOutput())
                || current() != null || entry != null && !atOrAfter(stamp, entry.row.latest())) return false;
        return store(new Wire(1, scope.run, scope.world, owner.toString(), ticket.toString(), ticket.toString(), scope.world,
            dimension, cell(pos), cell(footing), key(facing), itemId(batch.raw()), batch.units(), null, 0, 0,
            itemId(AgentLocalSmelt.result(batch.raw())), syncId, batch.minimumOutput(), 0, "live", "paid", stamp,
            null, null, null, null, null, null, true), null);
    }

    boolean park(UUID ticket, long tick, long frame) {
        Stamp stamp = stamp(tick, frame);
        if (!forEntry(ticket, stamp) || frame == 0) return false;
        if (entry.state == State.PARKED) return entry.basis != Basis.CLUE;
        if (entry.state != State.PAID || entry.basis != Basis.LIVE || entry.row.paid.life != life) return false;
        return store(entry.row.with(Basis.LIVE, State.PARKED, stamp, null, null, null), entry.batch);
    }

    boolean end(UUID ticket, State state, long tick, long frame) {
        Stamp stamp = stamp(tick, frame);
        if (!forEntry(ticket, stamp) || (state != State.COLLECTED && state != State.CANCELLED && state != State.DISAPPEARED))
            return false;
        if (entry.state == state) return true;
        if (current() == null || (state == State.COLLECTED && !entry.mayInvestigateCollection())) return false;
        Wire row = entry.row;
        return store(row.with(state == State.DISAPPEARED ? Basis.CLUE : entry.basis, state, row.parked, row.lost,
            state == State.DISAPPEARED ? stamp : row.gone, state == State.DISAPPEARED ? null : stamp), entry.batch);
    }

    void discontinuity(long tick, long frame) {
        if (current() == null || entry.basis == Basis.CLUE) return;
        Stamp stamp = stamp(tick, frame);
        if (stamp == null || !atOrAfter(stamp, entry.row.latest())) {
            failClosed();
            return;
        }
        store(entry.row.with(Basis.CLUE, entry.state, entry.row.parked, stamp, null, null), entry.batch);
    }

    void runnerClose(long tick, long frame, AgentWalkedRoute.Breadcrumbs breadcrumbs) {
        Stamp stamp = stamp(tick, frame);
        if (current() == null || !entry.mayInvestigateCollection() || stamp == null || life != 1 ||
                !atOrAfter(stamp, entry.row.latest())) return;
        try {
            String text = read(RECORD);
            if (!text.equals(committedText)) return;
            if (!AgentWalkedRoute.validBreadcrumbs(breadcrumbs, entry.pos.getX(), entry.pos.getY(), entry.pos.getZ()))
                breadcrumbs = null;
            atomic(CLOSE, JSON.toJson(new Close(1, stamp, entry.row.id, digest(text), breadcrumbs)));
        } catch (IOException ignored) { /* The runner treats missing close evidence as a clue. */ }
    }

    private boolean forEntry(UUID ticket, Stamp stamp) {
        return entry != null && entry.ticket.equals(ticket) && stamp != null && atOrAfter(stamp, entry.row.latest());
    }

    private Stamp stamp(long tick, long frame) {
        return scope == null || failed || tick < 1 || tick > MAX_NUMBER || frame < 0 || frame > MAX_NUMBER
            ? null : new Stamp(scope.run, life, tick, frame);
    }

    private static boolean atOrAfter(Stamp stamp, Stamp prior) {
        return !stamp.run.equals(prior.run) || stamp.tick >= prior.tick &&
            (stamp.life > prior.life || stamp.life == prior.life && stamp.frame >= prior.frame);
    }

    private boolean store(Wire row, AgentHands.IronBatch batch) {
        try {
            String text = JSON.toJson(row);
            atomic(RECORD, text);
            entry = new Entry(row, batch);
            committedText = text;
            return true;
        } catch (IOException ignored) {
            // No subsequent material action may rely on an uncommitted transition.
            failClosed();
            return false;
        }
    }

    private void failClosed() {
        failed = true;
        if (entry != null && entry.mayInvestigateCollection())
            entry = new Entry(entry.row.with(Basis.CLUE, entry.state, entry.row.parked,
                entry.row.lost, entry.row.gone, entry.row.ended), entry.batch);
    }

    private String read(String name) throws IOException {
        Path path = directory.resolve(name);
        var attr = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attr.isRegularFile() || attr.size() < 1 || attr.size() > BYTES ||
                !attr.owner().equals(Files.getOwner(directory, LinkOption.NOFOLLOW_LINKS)) ||
                !attr.permissions().equals(PRIVATE_MODE) ||
                !Integer.valueOf(1).equals(Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)))
            throw new IOException("Not a private pending-furnace artifact.");
        try (var channel = FileChannel.open(path, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer bytes = ByteBuffer.allocate((int) attr.size() + 1);
            while (bytes.hasRemaining() && channel.read(bytes) >= 0) { }
            if (bytes.position() != attr.size()) throw new IOException("Pending-furnace artifact changed.");
            return new String(bytes.array(), 0, bytes.position(), StandardCharsets.UTF_8);
        }
    }

    private void atomic(String name, String text) throws IOException {
        Path temporary = directory.resolve(TEMP);
        try (var channel = FileChannel.open(temporary, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
                PosixFilePermissions.asFileAttribute(PRIVATE_MODE))) {
            ByteBuffer bytes = StandardCharsets.UTF_8.encode(text);
            while (bytes.hasRemaining()) channel.write(bytes);
            channel.force(true);
        }
        Files.move(temporary, directory.resolve(name), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        try (var parent = FileChannel.open(directory, StandardOpenOption.READ)) { parent.force(true); }
    }

    private static boolean validBatch(AgentHands.IronBatch batch, int output, int fuel) {
        return batch != null && batch.fuel() != Items.AIR && AgentHands.workSmeltFuel(batch.fuel()) &&
            batch.units() >= 1 && batch.units() <= 64 && batch.fuelTicks() >= 1 && batch.fuelTicks() <= 1_600 &&
            batch.fuelCount() >= 1 && batch.fuelCount() <= 64 &&
            batch.fuelCount() == AgentHands.ironFuelNeeded(batch.units(), batch.fuelTicks()) &&
            output >= 0 && output <= batch.units() && fuel >= 0 && fuel <= batch.fuelCount();
    }

    private static boolean validOrdinary(Item raw, int units, int output) {
        return AgentLocalSmelt.result(raw) != Items.AIR && units >= 1 && units <= 3 && output >= 0 && output <= units;
    }

    private static Item knownItem(String id) {
        Identifier key = Identifier.tryParse(id);
        if (key == null || !Registries.ITEM.containsId(key)) throw new IllegalArgumentException();
        return Registries.ITEM.get(key);
    }

    private static String itemId(Item item) { return Registries.ITEM.getId(item).toString(); }

    private static boolean validStation(String dimension, BlockPos pos, BlockPos footing, Direction facing) {
        return dimension != null && DIMENSIONS.contains(dimension) && facing != null && facing.getAxis().isHorizontal()
            && validCell(pos) && validCell(footing) && Math.abs(pos.getX() - footing.getX()) <= 6
            && Math.abs(pos.getY() - footing.getY()) <= 6 && Math.abs(pos.getZ() - footing.getZ()) <= 6;
    }

    private static boolean validSync(int syncId) { return syncId >= 1 && syncId <= 255; }

    private static Map<Item, Integer> readFloors(Floor[] floors) {
        if (floors == null || floors.length == 0) return Map.of();
        if (floors.length > 32) throw new IllegalArgumentException();
        Map<Item, Integer> restrictions = new HashMap<>();
        for (Floor floor : floors) {
            if (floor == null || floor.item == null || !VANILLA_ITEM.matcher(floor.item).matches()
                    || floor.count < 1 || floor.count > 2_304) throw new IllegalArgumentException();
            Identifier id = Identifier.tryParse(floor.item);
            if (id == null || !Registries.ITEM.containsId(id)) throw new IllegalArgumentException();
            Item item = Registries.ITEM.get(id);
            if (item == Items.AIR || restrictions.put(item, floor.count) != null) throw new IllegalArgumentException();
        }
        return Map.copyOf(restrictions);
    }
    private static boolean validCell(BlockPos pos) {
        return pos != null && pos.getX() >= -30_000_000 && pos.getX() <= 30_000_000 && pos.getY() >= -64
            && pos.getY() <= 320 && pos.getZ() >= -30_000_000 && pos.getZ() <= 30_000_000;
    }
    private static boolean validUuid(String id) { return id != null && id.equals(UUID.fromString(id).toString()); }
    private static String key(Enum<?> value) { return value.name().toLowerCase(Locale.ROOT); }
    private static int[] cell(BlockPos pos) { return new int[] {pos.getX(), pos.getY(), pos.getZ()}; }
    private static BlockPos fromCell(int[] cell) {
        if (cell == null || cell.length != 3) throw new IllegalArgumentException();
        return new BlockPos(cell[0], cell[1], cell[2]);
    }
    private static String digest(String text) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }
}
