package io.gameharness.survival;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import org.lwjgl.system.MemoryUtil;

/** Two single-slot request mailboxes and one owned readback; never runs filesystem work on a tick or render. */
final class AgentVisualMailbox {
    private static final String CAPTURE = "visual-capture.json", CAPTURE_RESULT = "visual-capture-result.json";
    private static final String PROBE = "visual-probe.json", PROBE_RESULT = "visual-probe-result.json";
    private static final Set<PosixFilePermission> PRIVATE = PosixFilePermissions.fromString("rw-------");
    private static final Set<String> CAPTURE_FIELDS = Set.of("v", "run", "life", "epoch", "basisTick", "requestId");
    private static final Set<String> PROBE_FIELDS = Set.of("v", "run", "life", "epoch", "basisTick", "id", "requestId",
        "captureId", "imageSha256", "expiresTick", "region");
    private static final Set<String> REGION_FIELDS = Set.of("x", "y", "width", "height");
    private static final Set<String> ACTIVE_FIELDS = Set.of("v", "run", "workMode");
    private static final Pattern UUID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern CAPTURE_ID = Pattern.compile("vc-[0-9a-f]{32}");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private static final int JSON_LIMIT = 2048;
    static final int MAX_JPEG = 2 * 1024 * 1024;

    record Basis(int life, long epoch, long tick) {
        boolean current(int currentLife, long currentEpoch, long now, long maxAge) {
            return life == currentLife && epoch == currentEpoch && tick <= now && now - tick <= maxAge;
        }
    }
    record Capture(Basis basis, String id) {}
    record Probe(Basis basis, String id, String requestId, String captureId, String sha256,
                 long expires, AgentVisualProjection.Region region) {}

    record Readback(Capture request, AgentVisual.CaptureView view, ByteBuffer rgba, String failure) {
        void release() { if (rgba != null) MemoryUtil.memFree(rgba); }
    }
    record Bound(Capture request, AgentVisual.CaptureView view, String captureId, String sha256) {
        boolean matches(Probe probe) {
            return request.id.equals(probe.requestId) && captureId.equals(probe.captureId) && sha256.equals(probe.sha256)
                && probe.basis.life == request.basis.life && probe.basis.epoch == request.basis.epoch
                && probe.basis.tick >= request.basis.tick;
        }
    }
    record ProbeAnswer(Probe request, long tick, String status, AgentVisual.Surface surface, String subject,
                       double distance) {}
    record Scene(int life, long epoch, Object world, Object player) {
        boolean matches(Basis basis, Object world, Object player) {
            return life == basis.life && epoch == basis.epoch && this.world == world && this.player == player;
        }
    }

    private final Path directory;
    private final String run;
    private final ScheduledExecutorService worker;
    private final AtomicReference<Readback> readback = new AtomicReference<>();
    private final AtomicReference<ProbeAnswer> answer = new AtomicReference<>();
    final AtomicReference<Bound> bound = new AtomicReference<>();
    private UserPrincipal owner;
    private Object directoryKey;
    private String workMode;
    private String completedCapture, completedProbe;
    private boolean receiptOwned, activated;
    private Path staged;
    private Object stagedKey;
    private volatile boolean closed;
    volatile boolean authorized;
    volatile Scene scene;
    volatile Capture capture;
    volatile Probe probe;
    volatile ProbeAnswer publishedProbe;

    AgentVisualMailbox(Path directory, String run) {
        this.directory = directory;
        this.run = run;
        worker = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "survival-agent-visual-io");
            thread.setDaemon(true);
            return thread;
        });
        worker.scheduleWithFixedDelay(this::transfer, 0, 20, TimeUnit.MILLISECONDS);
    }

    void submit(Readback frame) {
        if (closed || !readback.compareAndSet(null, frame)) {
            frame.release();
        } else if (closed && readback.compareAndSet(frame, null)) {
            frame.release();
        }
    }

    void submit(ProbeAnswer result) { if (!closed) answer.compareAndSet(null, result); }

    synchronized void close() {
        if (closed) return;
        closed = true;
        authorized = false;
        scene = null;
        bound.set(null);
        var pending = readback.getAndSet(null);
        if (pending != null) pending.release();
        answer.set(null);
        // No join on the client thread. An in-flight readback is released by its worker finally block.
        worker.execute(this::cleanupCapture);
        worker.shutdown();
    }

    private void transfer() {
        if (closed) return;
        try {
            if (owner == null) {
                var attrs = Files.readAttributes(directory, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
                if (!attrs.isDirectory() || attrs.fileKey() == null) return;
                owner = attrs.owner();
                directoryKey = attrs.fileKey();
            }
            authorized = active();
            if (!authorized && activated) {
                close();
                return;
            }
            activated |= authorized;
            capture = authorized ? parseCapture(read(CAPTURE), run) : null;
            probe = authorized ? parseProbe(read(PROBE), run) : null;
            if (receiptOwned && (capture == null || !completedCapture.equals(capture.id)))
                cleanupCapture();
            var frame = readback.getAndSet(null);
            if (frame != null) {
                try { writeCapture(frame); }
                finally { frame.release(); }
            }
            var result = answer.getAndSet(null);
            if (result != null) writeProbe(result);
        } catch (IOException | RuntimeException ignored) {
            authorized = false;
            capture = null;
            probe = null;
        }
    }

    private boolean active() {
        if (closed) return false;
        try {
            var attrs = Files.readAttributes(directory, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attrs.isDirectory() || !owner.equals(attrs.owner()) || !directoryKey.equals(attrs.fileKey())) return false;
        } catch (IOException ignored) { return false; }
        JsonObject marker = read("active.json");
        if (marker == null || !marker.keySet().equals(ACTIVE_FIELDS)) return false;
        try {
            String mode = text(marker, "workMode");
            if (integer(marker, "v") != 1 || !run.equals(text(marker, "run"))
                    || !mode.equals("preset") && !mode.equals("constrained")) return false;
            if (workMode == null) workMode = mode;
            return workMode.equals(mode);
        } catch (RuntimeException invalid) {
            return false;
        }
    }

    private boolean live(Capture request) { return active() && request.equals(parseCapture(read(CAPTURE), run)); }
    private boolean live(Probe request) { return active() && request.equals(parseProbe(read(PROBE), run)); }

    private void writeCapture(Readback frame) throws IOException {
        Capture request = frame.request;
        if (request.id.equals(completedCapture) || !live(request)) return;
        cleanupCapture();
        JsonObject result = header(request.basis);
        result.addProperty("requestId", request.id);
        String failure = frame.failure;
        Bound source = null;
        if (failure == null) {
            Path temporary = temporary();
            try {
                var view = frame.view;
                String hash = AgentVisualImage.encode(frame.rgba, view.projection().width, view.projection().height,
                    temporary);
                if (!live(request)) return;
                if (!current(request.basis, view.world(), view.player())) failure = "basis_changed";
                else {
                    Path stage = directory.resolve("visual-frame-" + request.id + ".jpg");
                    // Link publishes complete bytes once without replacing an existing path.
                    var key = attributes(temporary).fileKey();
                    Files.createLink(stage, temporary);
                    staged = stage;
                    stagedKey = key;
                    source = new Bound(request, view, AgentVisual.opaque("vc-"), hash);
                }
            } catch (IOException | RuntimeException failed) {
                failure = "unavailable";
            } finally {
                Files.deleteIfExists(temporary);
            }
        }
        if (failure == null && source != null) {
            result.addProperty("status", "captured");
            result.addProperty("captureId", source.captureId);
            result.addProperty("renderFrame", source.view.renderFrame());
            result.addProperty("width", source.view.projection().width);
            result.addProperty("height", source.view.projection().height);
            result.addProperty("sha256", source.sha256);
        } else result.addProperty("status", failure == null ? "unavailable" : failure);
        if (!live(request)) {
            cleanupCapture();
            return;
        }
        boolean captured = source != null && failure == null;
        if (publish(CAPTURE_RESULT, "requestId", request.id, result, () -> live(request)
                && (!captured || current(request.basis, frame.view.world(), frame.view.player())))) {
            completedCapture = request.id;
            receiptOwned = true;
            if (captured && !closed) {
                bound.set(source);
                if (closed) bound.compareAndSet(source, null);
            }
        } else cleanupCapture();
        if (!live(request)) cleanupCapture();
    }

    private void writeProbe(ProbeAnswer response) throws IOException {
        Probe request = response.request;
        if (request.id.equals(completedProbe) || !live(request)) return;
        var surface = response.surface;
        if (surface != null && !current(request.basis, surface.world(), surface.player())) {
            response = new ProbeAnswer(request, response.tick, "basis_changed", null, null, 0);
            surface = null;
        }
        JsonObject result = header(request.basis);
        result.remove("basisTick");
        result.addProperty("id", request.id);
        result.addProperty("requestId", request.requestId);
        result.addProperty("captureId", request.captureId);
        result.addProperty("imageSha256", request.sha256);
        result.addProperty("tick", response.tick);
        result.addProperty("status", response.status);
        if (response.surface != null) {
            result.addProperty("candidateId", response.surface.id());
            result.addProperty("subject", response.subject);
            result.addProperty("distanceBlocks", response.distance);
        }
        var confirmed = surface;
        if (publish(PROBE_RESULT, "id", request.id, result, () -> live(request)
                && (confirmed == null || current(request.basis, confirmed.world(), confirmed.player())))) {
            completedProbe = request.id;
            publishedProbe = response;
        }
    }

    private boolean current(Basis basis, Object world, Object player) {
        var current = scene;
        return current != null && current.matches(basis, world, player);
    }

    private JsonObject header(Basis basis) {
        JsonObject value = new JsonObject();
        value.addProperty("v", 1);
        value.addProperty("run", run);
        value.addProperty("life", basis.life);
        value.addProperty("epoch", basis.epoch);
        value.addProperty("basisTick", basis.tick);
        return value;
    }

    private boolean publish(String file, String field, String id, JsonObject result,
                            java.util.function.BooleanSupplier stillLive) throws IOException {
        Path path = directory.resolve(file);
        // A mailbox may advance to a new ID, but it must never rewrite an existing receipt.
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            var previous = read(file);
            if (previous == null || id.equals(text(previous, field))) return false;
        }
        Path temporary = temporary();
        try {
            try (OutputStream out = Files.newOutputStream(temporary, LinkOption.NOFOLLOW_LINKS)) {
                out.write((result + "\n").getBytes(StandardCharsets.UTF_8));
            }
            if (!stillLive.getAsBoolean()) return false;
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return true;
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private Path temporary() throws IOException {
        return Files.createTempFile(directory, ".native-visual-", ".tmp", PosixFilePermissions.asFileAttribute(PRIVATE));
    }

    private void cleanupCapture() {
        try {
            if (staged != null && stagedKey != null && stagedKey.equals(attributes(staged).fileKey()))
                Files.deleteIfExists(staged);
        } catch (IOException | RuntimeException ignored) {
            // Host may already have closed its stage.
        } finally {
            staged = null;
            stagedKey = null;
        }
        if (receiptOwned) {
            receiptOwned = false;
            try {
                var previous = read(CAPTURE_RESULT);
                if (previous != null && completedCapture.equals(text(previous, "requestId")))
                    Files.deleteIfExists(directory.resolve(CAPTURE_RESULT));
            } catch (IOException | RuntimeException ignored) {
                // A newer request or the host owns the mailbox now.
            }
        }
    }

    private PosixFileAttributes attributes(Path path) throws IOException {
        var attrs = Files.readAttributes(path, PosixFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attrs.isRegularFile() || !owner.equals(attrs.owner()) || !PRIVATE.equals(attrs.permissions())
                || !Integer.valueOf(1).equals(Files.getAttribute(path, "unix:nlink", LinkOption.NOFOLLOW_LINKS)))
            throw new IOException("Not an owned private visual file");
        return attrs;
    }

    private JsonObject read(String file) {
        Path path = directory.resolve(file);
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return null;
        try {
            var before = attributes(path);
            if (before.size() <= 0 || before.size() > JSON_LIMIT || before.fileKey() == null) return null;
            try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
                byte[] bytes = stream.readNBytes(JSON_LIMIT + 1);
                var after = attributes(path);
                if (bytes.length != before.size() || !before.fileKey().equals(after.fileKey())
                        || !before.lastModifiedTime().equals(after.lastModifiedTime())) return null;
                return JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
            }
        } catch (IOException | RuntimeException ignored) {
            return null;
        }
    }

    static Capture parseCapture(JsonObject value, String run) {
        if (value == null || !value.keySet().equals(CAPTURE_FIELDS)) return null;
        try {
            Basis basis = basis(value, run);
            String id = text(value, "requestId");
            return basis != null && UUID.matcher(id).matches() ? new Capture(basis, id) : null;
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    static Probe parseProbe(JsonObject value, String run) {
        if (value == null || !value.keySet().equals(PROBE_FIELDS)) return null;
        try {
            Basis basis = basis(value, run);
            if (basis == null) return null;
            String id = text(value, "id"), requestId = text(value, "requestId"),
                captureId = text(value, "captureId"), hash = text(value, "imageSha256");
            long expires = integer(value, "expiresTick");
            var box = value.getAsJsonObject("region");
            if (!UUID.matcher(id).matches() || !UUID.matcher(requestId).matches() || id.equals(requestId)
                    || !CAPTURE_ID.matcher(captureId).matches() || !SHA256.matcher(hash).matches()
                    || expires <= basis.tick || expires - basis.tick > 80 || !box.keySet().equals(REGION_FIELDS)) return null;
            var region = new AgentVisualProjection.Region(scalar(box, "x"), scalar(box, "y"),
                scalar(box, "width"), scalar(box, "height"));
            return region.valid() ? new Probe(basis, id, requestId, captureId, hash, expires, region) : null;
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    private static Basis basis(JsonObject value, String run) {
        long life = integer(value, "life"), epoch = integer(value, "epoch"), tick = integer(value, "basisTick");
        return integer(value, "v") == 1 && run.equals(text(value, "run")) && life > 0 && life <= Integer.MAX_VALUE
            && epoch > 0 && tick > 0 ? new Basis((int) life, epoch, tick) : null;
    }

    private static long integer(JsonObject value, String field) {
        var primitive = value.getAsJsonPrimitive(field);
        if (!primitive.isNumber()) throw new IllegalArgumentException(field);
        long number = primitive.getAsBigDecimal().longValueExact();
        if (number < 0 || number > 9_007_199_254_740_991L) throw new IllegalArgumentException(field);
        return number;
    }

    private static double scalar(JsonObject value, String field) {
        var primitive = value.getAsJsonPrimitive(field);
        if (!primitive.isNumber()) throw new IllegalArgumentException(field);
        return primitive.getAsDouble();
    }

    private static String text(JsonObject value, String field) {
        var primitive = value.getAsJsonPrimitive(field);
        if (!primitive.isString()) throw new IllegalArgumentException(field);
        return primitive.getAsString();
    }
}
