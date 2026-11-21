package io.gameharness.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/** An optional strategy mailbox. Only the local motor knows when and how to use a choice. */
final class AgentExpedition {
    private static final int MAX_HORIZON = 1200, JSON_LIMIT = 2048;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final Pattern RUN = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern TOKEN = Pattern.compile("[a-z][a-z0-9_-]{0,63}");
    private static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Set<String> MARKER_FIELDS = Set.of("v", "run");
    private static final Set<String> ADVICE_FIELDS =
        Set.of("v", "run", "life", "goal", "id", "basisTick", "expiresTick", "need", "option");
    private static final Set<PosixFilePermission> PRIVATE_FILE = PosixFilePermissions.fromString("rw-------");
    private static final Set<PosixFilePermission> PRIVATE_DIRECTORY = PosixFilePermissions.fromString("rwx------");

    record Option(String id, String summary) {}

    // Identity distinguishes one opening from a later opportunity advertising the same strategies.
    static final class Offer {
        final String need;
        final List<Option> options;

        Offer(String need, Option... options) {
            this.need = need;
            this.options = List.of(options);
        }

        Option option(String id) {
            for (Option choice : options) if (choice.id.equals(id)) return choice;
            return null;
        }
    }

    record Applied(String id, String option, long tick) {}
    record Snapshot(int life, long tick, Offer offer, JsonObject inventory, float health, int food,
                    String activity, Applied applied) {}
    record Candidate(int life, long basis, long expires, String id, Offer offer, Option option) {
        boolean current(int currentLife, long now, Offer live) {
            return life == currentLife && offer == live && basis <= now && now <= expires;
        }
    }

    static final class Choice {
        private final Set<String> used = new HashSet<>();
        private final Set<Offer> committed = new HashSet<>();
        private Applied applied;

        Option take(Candidate candidate, int life, long tick, Offer offer, boolean safe) {
            if (!safe || candidate == null || offer == null || committed.contains(offer)
                    || !candidate.current(life, tick, offer) || !used.add(candidate.id)) return null;
            committed.add(offer);
            applied = new Applied(candidate.id, candidate.option.id, tick);
            return candidate.option;
        }

        Applied applied() { return applied; }
        void reset() { committed.clear(); applied = null; }
    }

    static final class Prospecting {
        enum Turn { LOCAL, SCOUT, EXCAVATE }

        static final Option VISIBLE = new Option("prospect_visible",
            "Survey for exposed ore or a safely reachable cave before the next excavation leg.");
        static final Option STAIR = new Option("excavate_checked_route",
            "Prefer a checked, lit excavation such as a returnable stair over an optional cave survey.");
        private final Offer offer;
        private Turn selected = Turn.LOCAL;
        private int scoutUntil, view;
        private boolean decided, overland;

        Prospecting(String need) {
            offer = new Offer(need, VISIBLE, STAIR);
        }

        Offer live() { return decided ? null : offer; }
        boolean scouting(int tick) { return selected == Turn.SCOUT && tick < scoutUntil && (overland || view < 3); }
        boolean overland() { return overland; }
        int view() { return view; }
        void sawView() { ++view; }

        void choose(Option choice, int tick, boolean overland) {
            if (decided || choice == null) return;
            decided = true;
            selected = choice == STAIR ? Turn.EXCAVATE : Turn.SCOUT;
            this.overland = overland;
            scoutUntil = tick + (overland ? 230 : 105);
        }

        Turn turn(int tick) {
            if (scouting(tick)) return Turn.SCOUT;
            Turn next = selected == Turn.EXCAVATE ? Turn.EXCAVATE : Turn.LOCAL;
            selected = Turn.LOCAL;
            return next;
        }
    }

    private final Transport transport;
    private final ScheduledExecutorService worker;
    private final AtomicReference<Snapshot> pending = new AtomicReference<>();
    private final Choice choice = new Choice();
    private volatile Candidate candidate;
    private volatile boolean enabled = true;
    private boolean closed;
    private int life;
    private long tick;
    private Snapshot last;

    static AgentExpedition open(Path runDir, String goal) {
        Transport transport = Transport.open(runDir, goal);
        return transport == null ? null : new AgentExpedition(transport);
    }

    private AgentExpedition(Transport transport) {
        this.transport = transport;
        worker = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "survival-agent-expedition-io");
            thread.setDaemon(true);
            return thread;
        });
        worker.scheduleWithFixedDelay(this::exchange, 0, 125, TimeUnit.MILLISECONDS);
    }

    void begin(int life, long tick) {
        this.life = life;
        this.tick = tick;
    }

    Option take(Offer offer, boolean safe) {
        return enabled && !closed ? choice.take(candidate, life, tick, offer, safe) : null;
    }

    boolean hasAdvice(Offer offer) {
        Candidate latest = candidate;
        return enabled && !closed && latest != null && latest.current(life, tick, offer);
    }

    boolean shouldPublish(Offer offer, String activity) {
        return enabled && !closed && (last == null || last.life != life || last.offer != offer
            || last.applied != choice.applied() || !activity.equals(last.activity) || tick - last.tick >= 10);
    }

    void publish(Offer offer, JsonObject inventory, float health, int food, String activity) {
        if (!enabled || closed) return;
        last = new Snapshot(life, tick, offer, inventory, health, food, activity, choice.applied());
        pending.set(last);
    }

    void reset() {
        choice.reset();
        candidate = null;
        last = null;
        pending.set(null);
    }

    void close() {
        if (closed) return;
        closed = true;
        // Flush a terminal snapshot without waiting for disk on the Minecraft thread.
        worker.execute(this::exchange);
        worker.shutdown();
    }

    private void exchange() {
        if (!enabled) return;
        if (!transport.active()) {
            enabled = false;
            candidate = null;
            pending.set(null);
            return;
        }
        Snapshot latest = pending.getAndSet(null);
        if (latest != null) {
            try {
                transport.publish(latest);
            } catch (IOException | RuntimeException ignored) {
                // A missing/read-only side channel cannot stop the player.
            }
        }
        candidate = transport.readAdvice();
    }

    static final class Transport {
        private record Basis(int life, long tick, Offer offer) {}

        private final Path directory;
        private final Path marker, state, advice;
        private final String run, goal;
        private final UserPrincipal owner;
        private final Object directoryKey;
        private final Basis[] published = new Basis[MAX_HORIZON + 1];

        private Transport(Path directory, String run, String goal, PosixFileAttributes attributes) {
            this.directory = directory;
            marker = directory.resolve("active.json");
            state = directory.resolve("state.json");
            advice = directory.resolve("advice.json");
            this.run = run;
            this.goal = goal;
            owner = attributes.owner();
            directoryKey = attributes.fileKey();
        }

        static Transport open(Path runDir, String goal) {
            Path directory = runDir.resolve("expedition");
            String run = runDir.getFileName().toString();
            if (!RUN.matcher(run).matches()) return null;
            try {
                var attrs = Files.readAttributes(directory, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attrs.isDirectory() || attrs.fileKey() == null || !attrs.permissions().equals(PRIVATE_DIRECTORY)
                        || !attrs.owner().equals(Files.getOwner(runDir, LinkOption.NOFOLLOW_LINKS))) return null;
                Transport transport = new Transport(directory, run, goal, attrs);
                return transport.active() ? transport : null;
            } catch (IOException | RuntimeException invalid) {
                return null;
            }
        }

        boolean active() {
            try {
                var attrs = Files.readAttributes(directory, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attrs.isDirectory() || !owner.equals(attrs.owner()) || !directoryKey.equals(attrs.fileKey())
                        || !attrs.permissions().equals(PRIVATE_DIRECTORY)) return false;
                JsonObject value = read(marker);
                return value != null && value.keySet().equals(MARKER_FIELDS) && header(value);
            } catch (IOException | RuntimeException invalid) {
                return false;
            }
        }

        void publish(Snapshot snap) throws IOException {
            var value = new JsonObject();
            value.addProperty("v", 1);
            value.addProperty("run", run);
            value.addProperty("life", snap.life);
            value.addProperty("goal", goal);
            value.addProperty("tick", snap.tick);
            value.addProperty("need", snap.offer == null ? "none" : snap.offer.need);
            var options = new JsonArray(snap.offer == null ? 0 : snap.offer.options.size());
            if (snap.offer != null) {
                for (Option option : snap.offer.options) {
                    var item = new JsonObject();
                    item.addProperty("id", option.id);
                    item.addProperty("summary", option.summary);
                    options.add(item);
                }
            }
            value.add("options", options);
            value.add("inventory", snap.inventory);
            value.addProperty("health", snap.health);
            value.addProperty("food", snap.food);
            value.addProperty("activity", snap.activity);
            if (snap.applied != null) {
                var applied = new JsonObject();
                applied.addProperty("id", snap.applied.id);
                applied.addProperty("option", snap.applied.option);
                applied.addProperty("tick", snap.applied.tick);
                value.add("applied", applied);
            }
            Path draft = Files.createTempFile(directory, ".native-state-", ".tmp",
                PosixFilePermissions.asFileAttribute(PRIVATE_FILE));
            try {
                Files.writeString(draft, value + "\n", LinkOption.NOFOLLOW_LINKS);
                Files.move(draft, state, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                published[slot(snap.tick)] = snap.offer == null ? null : new Basis(snap.life, snap.tick, snap.offer);
            } finally {
                Files.deleteIfExists(draft);
            }
        }

        Candidate readAdvice() {
            try {
                JsonObject value = read(advice);
                if (value == null || !value.keySet().equals(ADVICE_FIELDS) || !header(value)
                        || !goal.equals(text(value, "goal"))) return null;
                long life = integer(value, "life"), tick = integer(value, "basisTick");
                long until = integer(value, "expiresTick");
                if (until <= tick || until - tick > MAX_HORIZON) return null;
                Basis basis = published[slot(tick)];
                if (basis == null || basis.life != life || basis.tick != tick) return null;
                String id = text(value, "id"), need = text(value, "need"), option = text(value, "option");
                if (!UUID.matcher(id).matches() || !TOKEN.matcher(need).matches() || !TOKEN.matcher(option).matches()
                        || !basis.offer.need.equals(need)) return null;
                Option admitted = basis.offer.option(option);
                return admitted == null ? null : new Candidate(basis.life, tick, until, id, basis.offer, admitted);
            } catch (RuntimeException invalid) {
                return null;
            }
        }

        private boolean header(JsonObject value) {
            return integer(value, "v") == 1 && run.equals(text(value, "run"));
        }

        private JsonObject read(Path path) {
            try {
                var before = privateFile(path);
                if (before.size() <= 0 || before.size() > JSON_LIMIT) return null;
                try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
                    byte[] bytes = stream.readNBytes(JSON_LIMIT + 1);
                    var after = privateFile(path);
                    if (bytes.length != before.size() || bytes.length != after.size()
                            || !before.fileKey().equals(after.fileKey())
                            || !before.lastModifiedTime().equals(after.lastModifiedTime())) return null;
                    return JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
                }
            } catch (IOException | RuntimeException invalid) {
                return null;
            }
        }

        private PosixFileAttributes privateFile(Path path) throws IOException {
            var attrs = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attrs.isRegularFile() || !owner.equals(attrs.owner()) || attrs.fileKey() == null
                    || !attrs.permissions().equals(PRIVATE_FILE)
                    || !Integer.valueOf(1).equals(Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)))
                throw new IOException("Not an owned private expedition file");
            return attrs;
        }

        private static int slot(long tick) { return (int) (tick % (MAX_HORIZON + 1)); }

        private static long integer(JsonObject value, String field) {
            var scalar = value.getAsJsonPrimitive(field);
            if (!scalar.isNumber()) throw new IllegalArgumentException(field);
            long number = scalar.getAsBigDecimal().longValueExact();
            if (number < 0 || number > MAX_SAFE_INTEGER) throw new IllegalArgumentException(field);
            return number;
        }

        private static String text(JsonObject value, String field) {
            var scalar = value.getAsJsonPrimitive(field);
            if (!scalar.isString()) throw new IllegalArgumentException(field);
            return scalar.getAsString();
        }
    }
}
