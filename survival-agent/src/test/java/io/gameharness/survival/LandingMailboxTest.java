package io.gameharness.survival;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertEquals;

final class LandingMailboxTest {
    @Test
    void replacingTheLandingSnapshotDoesNotBlockARealControlReceipt(@TempDir Path directory) throws Exception {
        Files.writeString(directory.resolve("active.json"), "{\"v\":1,\"run\":\"test\",\"workMode\":\"constrained\"}");
        Files.writeString(directory.resolve("dry-landing-last.json"), "{\"stage\":\"old\"}\n");
        var ipc = new AgentMacroControl.Ipc(directory, "test", "constrained");
        String receipt = "{\"id\":\"work-1\",\"status\":\"accepted\"}";
        try {
            for (int tick = 1; tick <= 64; tick++) ipc.landingSnapshot("{\"tick\":" + tick + "}");
            ipc.receipt(receipt);
        } finally {
            ipc.close();
            ipc.drain();
        }
        assertEquals("{\"tick\":64}\n", Files.readString(directory.resolve("dry-landing-last.json")));
        assertEquals(List.of(receipt), Files.readAllLines(directory.resolve("native-receipts.jsonl")));
        assertEquals(receipt + "\n", Files.readString(directory.resolve("receipt.json")));
    }
}
