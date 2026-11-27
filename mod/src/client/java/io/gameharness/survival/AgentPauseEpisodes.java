package io.gameharness.survival;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.channels.Channels;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;

/** Read-only gameplay timeline. A host observer scores pauses, not the input policy. */
final class AgentPauseEpisodes {
    enum Work {
        CRACK("crack"), ROUTE("route"), GUI("gui"), NOVELTY("novelty"), SAFETY("safety"),
        MECHANICAL_WAIT("mechanical_wait");

        private final String state;
        Work(String state) { this.state = state; }
    }

    private static final int MAX_ROWS = 16_384;
    private static final long HEARTBEAT_NS = 500_000_000L;
    private static final long MAX_WITNESS_INTERVAL_NS = 150_000_000L;
    private BufferedWriter out;
    private long lastNs, lastTick, lastPulse;
    private int rows;
    private boolean firstInput;
    private String state = "idle";

    AgentPauseEpisodes(Path directory, long tick) {
        try {
            var channel = FileChannel.open(directory.resolve("native-pause-timeline.tsv"),
                Set.of(StandardOpenOption.WRITE, StandardOpenOption.CREATE_NEW),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            out = new BufferedWriter(Channels.newWriter(channel, StandardCharsets.UTF_8));
            out.write("v1\t");
            out.write(directory.getFileName().toString());
            out.newLine();
            lastNs = lastPulse = System.nanoTime();
            lastTick = tick;
            line("state", lastNs, tick, state);
            out.flush();
        } catch (IOException | UnsupportedOperationException failure) {
            stopWriting();
        }
    }

    void sample(long tick, Work work, boolean actualInput, boolean cameraChanged, boolean blocked) {
        if (out == null) return;
        long now = System.nanoTime();
        try {
            // One sample can append a state, first input, and heartbeat.
            if (rows >= MAX_ROWS - 3) {
                line("limit", lastNs, lastTick, null);
                stopWriting();
                return;
            }
            // A new sample witnesses at most one regular tick interval. Never
            // fill a stopped client's wall time with an old work classification.
            String observed = now - lastNs > MAX_WITNESS_INTERVAL_NS ? "unsampled"
                : work != null ? work.state : cameraChanged ? "aim_unverified"
                : actualInput ? "input_unverified" : blocked ? "blocked" : "idle";
            if (!state.equals(observed)) {
                line("state", lastNs, lastTick, observed);
                state = observed;
            }
            lastNs = now;
            lastTick = tick;
            if (actualInput && !firstInput) {
                line("input", now, tick, null);
                firstInput = true;
            }
            if (now - lastPulse >= HEARTBEAT_NS) {
                line("pulse", now, tick, null);
                lastPulse = now;
                out.flush();
            }
        } catch (IOException failure) {
            stopWriting();
        }
    }

    void close(String reason) {
        if (out == null) return;
        try {
            long now = System.nanoTime();
            if (now - lastNs > MAX_WITNESS_INTERVAL_NS) {
                line("state", lastNs, lastTick, "unsampled");
            }
            line("end", Math.max(now, lastNs), lastTick, reason);
        } catch (IOException ignored) {
            // An absent terminal record leaves the report explicitly censored.
        } finally {
            stopWriting();
        }
    }

    private void line(String kind, long nanos, long tick, String value) throws IOException {
        out.write(kind);
        out.write('\t');
        out.write(Long.toString(nanos));
        out.write('\t');
        out.write(Long.toString(tick));
        if (value != null) {
            out.write('\t');
            out.write(value);
        }
        out.newLine();
        ++rows;
    }

    private void stopWriting() {
        if (out == null) return;
        try { out.close(); }
        catch (IOException ignored) { /* The verifier treats an incomplete file as missing coverage. */ }
        out = null;
    }
}
