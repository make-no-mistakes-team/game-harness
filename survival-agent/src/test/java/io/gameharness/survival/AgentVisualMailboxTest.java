package io.gameharness.survival;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.function.BooleanSupplier;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.lwjgl.system.MemoryUtil;

import static org.junit.jupiter.api.Assertions.*;

final class AgentVisualMailboxTest {
    private static final String RUN = "actor-run";
    private static final String REQUEST = "12345678-1234-1234-1234-123456789123";
    private static final String PROBE = "a2345678-1234-1234-1234-123456789123";
    private static final String NEXT_PROBE = "b2345678-1234-1234-1234-123456789123";
    private static final String CAPTURE = "vc-" + "2".repeat(32);
    private static final String SHA256 = "a".repeat(64);
    private static final String CAPTURE_REQUEST = """
        {"v":1,"run":"actor-run","life":1,"epoch":4,"basisTick":20,"requestId":"%s"}
        """.formatted(REQUEST);
    private static final String PROBE_REQUEST = """
        {"v":1,"run":"actor-run","life":1,"epoch":4,"basisTick":22,"id":"%s","requestId":"%s",
         "captureId":"%s","imageSha256":"%s","expiresTick":62,"region":{"x":0.2,"y":0.2,"width":0.1,"height":0.1}}
        """.formatted(PROBE, REQUEST, CAPTURE, SHA256);
    @TempDir Path directory;

    @Test
    void onlyExactImageBindingAndCurrentScopeCanIdentifyTheSourceCapture() {
        var capture = AgentVisualMailbox.parseCapture(json(CAPTURE_REQUEST), RUN);
        assertNotNull(capture);
        var source = new AgentVisualMailbox.Bound(capture, null, CAPTURE, SHA256);
        assertTrue(source.matches(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST), RUN)));
        assertFalse(source.matches(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace(SHA256, "b".repeat(64))), RUN)));
        assertFalse(source.matches(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace(CAPTURE, "vc-" + "3".repeat(32))), RUN)));
        assertFalse(source.matches(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace("\"epoch\":4", "\"epoch\":5")), RUN)));
        assertFalse(source.matches(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace("\"basisTick\":22", "\"basisTick\":19")), RUN)));
        assertTrue(capture.basis().current(1, 4, 60, 40));
        assertFalse(capture.basis().current(1, 4, 61, 40));
        assertFalse(capture.basis().current(1, 4, 19, 40));
        var view = new AgentVisual.CaptureView(null, null, null, 15, 22, 100);
        assertTrue(view.fresh(622, 30_000_000_100L));
        assertFalse(view.fresh(623, 30_000_000_100L));
        assertFalse(view.fresh(622, 30_000_000_101L));
    }

    @Test
    void malformedRegionPathAndExpiryDoNotProduceReaderWork() {
        assertNull(AgentVisualMailbox.parseCapture(json(CAPTURE_REQUEST.replace(REQUEST, "../image")), RUN));
        assertNull(AgentVisualMailbox.parseCapture(json(CAPTURE_REQUEST.replace("\"life\":1", "\"life\":\"1\"")), RUN));
        assertNull(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace("\"x\":0.2", "\"x\":0.99")), RUN));
        assertNull(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace("\"y\":0.2", "\"y\":1e400")), RUN));
        assertNull(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace("\"width\":0.1", "\"width\":0.36")), RUN));
        assertNull(AgentVisualMailbox.parseProbe(json(PROBE_REQUEST.replace("\"expiresTick\":62", "\"expiresTick\":103")), RUN));
    }

    @Test
    void jpgStageBindsExactBytesAndTopDownRowsBeforeItsStableReceipt() throws Exception {
        active();
        put("visual-capture.json", CAPTURE_REQUEST);
        var worker = new AgentVisualMailbox(directory, RUN);
        try {
            await(() -> worker.capture != null);
            var req = worker.capture;
            worker.scene = new AgentVisualMailbox.Scene(1, 4, null, null);
            var projection = new AgentVisualProjection();
            projection.width = 32;
            projection.height = 32;
            var view = new AgentVisual.CaptureView(projection, null, null, 17, 22, System.nanoTime());
            ByteBuffer data = MemoryUtil.memAlloc(32 * 32 * 4);
            for (int y = 0; y < 32; y++)
                for (int x = 0; x < 32; x++)
                    data.put((byte) (y < 16 ? 240 : 10)).put((byte) 10).put((byte) (y < 16 ? 10 : 240)).put((byte) 255);
            data.flip();
            worker.submit(new AgentVisualMailbox.Readback(req, view, data, null));
            Path receipt = directory.resolve("visual-capture-result.json");
            await(() -> Files.isRegularFile(receipt));
            var result = json(Files.readString(receipt));
            assertEquals("captured", result.get("status").getAsString());
            assertEquals(17, result.get("renderFrame").getAsLong());
            assertEquals(32, result.get("width").getAsInt());
            assertEquals(32, result.get("height").getAsInt());
            Path stage = directory.resolve("visual-frame-" + REQUEST + ".jpg");
            byte[] jpeg = Files.readAllBytes(stage);
            assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(jpeg)),
                result.get("sha256").getAsString());
            var decoded = ImageIO.read(stage.toFile());
            assertTrue((decoded.getRGB(8, 3) & 0xff) > 200, "GL's last, blue row is at the top");
            assertTrue((decoded.getRGB(8, 28) >> 16 & 0xff) > 200, "GL's first, red row is at the bottom");
            assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(stage));
            assertEquals(1, Files.getAttribute(stage, "unix:nlink"));
            Files.delete(directory.resolve("visual-capture.json"));
            await(() -> !Files.exists(receipt) && !Files.exists(stage));
            assertNotNull(worker.bound.get(), "the verified source remains after the host consumes the stage");
        } finally { worker.close(); }
    }

    @Test
    void aNewProbeAdvancesTheSlotButReplayCannotRewriteThePreviousReceipt() throws Exception {
        active();
        put("visual-probe.json", PROBE_REQUEST);
        var worker = new AgentVisualMailbox(directory, RUN);
        try {
            await(() -> worker.probe != null);
            var first = worker.probe;
            worker.submit(new AgentVisualMailbox.ProbeAnswer(first, 25, "occluded", null, null, 0));
            Path receipt = directory.resolve("visual-probe-result.json");
            await(() -> worker.publishedProbe != null);
            String original = Files.readString(receipt);
            worker.submit(new AgentVisualMailbox.ProbeAnswer(first, 26, "dark", null, null, 0));
            Thread.sleep(70);
            assertEquals(original, Files.readString(receipt));

            put("visual-probe.json", PROBE_REQUEST.replace(PROBE, NEXT_PROBE));
            await(() -> worker.probe != null && worker.probe.id().equals(NEXT_PROBE));
            assertEquals(original, Files.readString(receipt), "the old receipt stays until the new one is complete");
            worker.submit(new AgentVisualMailbox.ProbeAnswer(worker.probe, 27, "miss", null, null, 0));
            await(() -> worker.publishedProbe.request().id().equals(NEXT_PROBE));
            var result = json(Files.readString(receipt));
            assertEquals(NEXT_PROBE, result.get("id").getAsString());
            assertEquals("miss", result.get("status").getAsString());
            assertFalse(result.has("candidateId"));
            assertFalse(result.has("basisTick"));
        } finally { worker.close(); }
    }

    @Test
    void symlinkAndMultiLinkRequestsAreNotAdmitted() throws Exception {
        active();
        put("separate-probe.json", PROBE_REQUEST);
        Path request = directory.resolve("visual-probe.json");
        Files.createSymbolicLink(request, Path.of("separate-probe.json"));
        var worker = new AgentVisualMailbox(directory, RUN);
        try {
            put("visual-capture.json", CAPTURE_REQUEST);
            await(() -> worker.capture != null);
            var first = worker.capture;
            worker.submit(new AgentVisualMailbox.Readback(first, null, null, "unavailable"));
            Path receipt = directory.resolve("visual-capture-result.json");
            await(() -> Files.isRegularFile(receipt));
            assertNull(worker.probe);
            Files.delete(request);
            Files.createLink(request, directory.resolve("separate-probe.json"));
            Files.delete(directory.resolve("visual-capture.json"));
            await(() -> !Files.exists(receipt));
            assertNull(worker.probe);
            Files.delete(request);
            put("visual-probe.json", PROBE_REQUEST);
            await(() -> worker.probe != null);
        } finally { worker.close(); }
    }

    private void active() throws IOException {
        put("active.json", "{\"v\":1,\"run\":\"actor-run\",\"workMode\":\"constrained\"}");
    }

    private void put(String file, String value) throws IOException {
        Path temp = Files.createTempFile(directory, ".host", ".tmp",
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(temp, value);
        Files.move(temp, directory.resolve(file), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private static JsonObject json(String text) { return JsonParser.parseString(text).getAsJsonObject(); }

    private static void await(BooleanSupplier condition) {
        assertTimeoutPreemptively(Duration.ofSeconds(3), () -> {
            while (!condition.getAsBoolean()) Thread.sleep(5);
        });
    }
}
