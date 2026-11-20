package io.gameharness.survival;

import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.UUID;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.item.Items;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

final class PendingFurnaceMemoryTest {
    private static final UUID OWNER = UUID.fromString("38fff701-c3bb-341d-a221-65bcbd4bb479");
    private static final UUID TICKET = UUID.fromString("00000000-0000-4000-8000-000000000002");
    private static final UUID OTHER = UUID.fromString("00000000-0000-4000-8000-000000000003");
    private static final String RUN = "2026-11-20T07-00-28.012Z-diamond-Ab123Z";

    @TempDir Path temporary;

    @BeforeAll
    static void vanilla() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    private Path runDirectory() throws IOException {
        Path run = Files.createDirectory(temporary.resolve(RUN));
        Path scope = Files.createFile(run.resolve("pending-furnace-scope.json"),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(scope, """
            {"v":1,"run":"%s","world":"00000000-0000-4000-8000-000000000001"}
            """.formatted(RUN));
        return run;
    }

    private static boolean pay(AgentPendingFurnaceMemory memory, UUID id, long tick) {
        return memory.pay(id, "minecraft:overworld", new BlockPos(-1, 28, 513), Direction.NORTH,
            new BlockPos(-2, 28, 513), new AgentHands.IronBatch(2, Items.COAL, 1, 1600), 3, 0, 1,
            tick, 82);
    }

    @Test
    void onePaidTicketKeepsOriginalStampsAcrossIdempotentParkAndCollect() throws IOException {
        Path dir = runDirectory();
        var memory = new AgentPendingFurnaceMemory(dir);
        assertTrue(memory.bind(OWNER, 1, 1, 1));
        assertTrue(pay(memory, TICKET, 25));
        assertTrue(pay(memory, TICKET, 25));
        assertFalse(pay(memory, OTHER, 25));
        assertTrue(memory.park(TICKET, 40, 130));
        assertTrue(memory.park(TICKET, 41, 140));
        assertTrue(memory.end(TICKET, AgentPendingFurnaceMemory.State.COLLECTED, 400, 1500));
        assertTrue(memory.end(TICKET, AgentPendingFurnaceMemory.State.COLLECTED, 400, 1500));
        assertNull(memory.current());
        assertFalse(pay(memory, TICKET, 401));
        var row = JsonParser.parseString(Files.readString(dir.resolve("pending-furnace.json"))).getAsJsonObject();
        assertEquals("collected", row.get("state").getAsString());
        assertEquals(25, row.getAsJsonObject("paid").get("tick").getAsLong());
        assertEquals(40, row.getAsJsonObject("parked").get("tick").getAsLong());
        assertEquals(400, row.getAsJsonObject("ended").get("tick").getAsLong());
    }

    @Test
    void anotherLifeAndObservedDisappearanceCannotCollectOrClaimAnOrderlyClose() throws IOException {
        Path dir = runDirectory();
        var memory = new AgentPendingFurnaceMemory(dir);
        assertTrue(memory.bind(OWNER, 1, 1, 1));
        assertTrue(pay(memory, TICKET, 25));
        assertTrue(memory.bind(OWNER, 2, 500, 1));
        assertTrue(memory.current().historical());
        assertFalse(memory.current().mayInvestigateCollection());
        assertFalse(memory.end(TICKET, AgentPendingFurnaceMemory.State.COLLECTED, 501, 4));
        assertTrue(memory.end(TICKET, AgentPendingFurnaceMemory.State.DISAPPEARED, 502, 6));
        assertEquals(AgentPendingFurnaceMemory.State.DISAPPEARED, memory.current().state());
        memory.runnerClose(505, 9);
        assertFalse(Files.exists(dir.resolve("pending-furnace-close.json")));
        var row = JsonParser.parseString(Files.readString(dir.resolve("pending-furnace.json"))).getAsJsonObject();
        assertEquals("disappeared", row.get("state").getAsString());
        assertEquals(500, row.getAsJsonObject("lost").get("tick").getAsLong());
        assertEquals(502, row.getAsJsonObject("gone").get("tick").getAsLong());
    }
}
