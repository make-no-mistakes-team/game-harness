package io.gameharness.survival;

import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;
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
        VanillaTestResources.initialize();
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
            Map.of(Items.COBBLESTONE, 3), tick, 82);
    }

    @Test
    void nativeCharcoalStoresThePaidCountSeparatelyFromProtectedIron() throws IOException {
        var dir = runDirectory();
        var memory = new AgentPendingFurnaceMemory(dir);
        assertTrue(memory.bind(OWNER, 1, 1, 0));
        var batch = new AgentLocalSmelt.Batch(Items.STRIPPED_BIRCH_WOOD, 3, 2);
        assertTrue(memory.payOrdinary(TICKET, "minecraft:overworld", new BlockPos(-1, 28, 513), Direction.NORTH,
            new BlockPos(-2, 28, 513), batch, 1, 25, 83));
        assertTrue(memory.park(TICKET, 35, 112));
        assertEquals(batch, memory.current().ordinaryBatch());
        assertNull(memory.current().batch());
        assertFalse(pay(memory, OTHER, 40));
        memory.runnerClose(120, 330, null);
        var row = JsonParser.parseString(Files.readString(dir.resolve("pending-furnace.json"))).getAsJsonObject();
        assertTrue(row.get("ordinary").getAsBoolean());
        assertEquals(3, row.get("units").getAsInt());
        assertEquals(2, row.get("minimumOutput").getAsInt());
        assertFalse(row.has("fuel"));
        assertTrue(Files.exists(dir.resolve("pending-furnace-close.json")));
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
        assertEquals(Map.of(Items.COBBLESTONE, 3), memory.current().floors());
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
        memory.runnerClose(505, 9, new AgentWalkedRoute.Breadcrumbs(new int[] {-2, 28, 513},
            new int[][] {{-3, 27, 513, -2, 28, 513}}));
        assertFalse(Files.exists(dir.resolve("pending-furnace-close.json")));
        var row = JsonParser.parseString(Files.readString(dir.resolve("pending-furnace.json"))).getAsJsonObject();
        assertEquals("disappeared", row.get("state").getAsString());
        assertEquals(500, row.getAsJsonObject("lost").get("tick").getAsLong());
        assertEquals(502, row.getAsJsonObject("gone").get("tick").getAsLong());
    }

    @Test
    void cleanAwayCloseBindsWalkedCluesToTheUnchangedPaidTicket() throws IOException {
        Path dir = runDirectory();
        var memory = new AgentPendingFurnaceMemory(dir);
        assertTrue(memory.bind(OWNER, 1, 1, 1));
        assertTrue(pay(memory, TICKET, 25));
        assertTrue(memory.park(TICKET, 40, 130));
        String paid = Files.readString(dir.resolve("pending-furnace.json"));
        memory.runnerClose(120, 330, new AgentWalkedRoute.Breadcrumbs(new int[] {-2, 28, 513},
            new int[][] {{-3, 27, 514, -3, 27, 513}, {-3, 27, 513, -2, 28, 513}}));
        assertEquals(paid, Files.readString(dir.resolve("pending-furnace.json")));
        var close = JsonParser.parseString(Files.readString(dir.resolve("pending-furnace-close.json"))).getAsJsonObject();
        assertEquals(TICKET.toString(), close.get("id").getAsString());
        assertEquals(2, close.getAsJsonObject("breadcrumbs").getAsJsonArray("edges").size());
        assertEquals(Map.of(Items.COBBLESTONE, 3), memory.current().floors());
    }

    @Test
    void onlyAProvedSameOwnerResumeExposesRestoredWalkedClues() throws Exception {
        Path parent = runDirectory();
        var original = new AgentPendingFurnaceMemory(parent);
        assertTrue(original.bind(OWNER, 1, 1, 1));
        assertTrue(pay(original, TICKET, 25));
        original.runnerClose(120, 330, new AgentWalkedRoute.Breadcrumbs(new int[] {-2, 28, 513},
            new int[][] {{-3, 27, 513, -2, 28, 513}}));
        var row = JsonParser.parseString(Files.readString(parent.resolve("pending-furnace.json"))).getAsJsonObject();
        var close = JsonParser.parseString(Files.readString(parent.resolve("pending-furnace-close.json"))).getAsJsonObject();
        String childRun = "2026-11-20T07-00-30.012Z-diamond-Ab123Z";
        String childWorld = "00000000-0000-4000-8000-000000000010";
        row.addProperty("run", childRun);
        row.addProperty("world", childWorld);
        row.addProperty("id", OTHER.toString());
        row.addProperty("basis", "resume");
        row.add("breadcrumbs", close.getAsJsonObject("breadcrumbs"));
        Path child = Files.createDirectory(temporary.resolve(childRun));
        var privateMode = PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"));
        String text = row.toString();
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        Files.writeString(Files.createFile(child.resolve("pending-furnace.json"), privateMode), text);
        Files.writeString(Files.createFile(child.resolve("pending-furnace-scope.json"), privateMode), """
            {"v":1,"run":"%s","world":"%s","resume":"%s"}
            """.formatted(childRun, childWorld, hash));

        var foreign = new AgentPendingFurnaceMemory(child);
        assertFalse(foreign.bind(OTHER, 1, 1, 1));
        assertNull(foreign.current());
        var nativeResume = new AgentPendingFurnaceMemory(child);
        assertTrue(nativeResume.bind(OWNER, 1, 1, 1));
        assertEquals(OTHER, nativeResume.current().ticket());
        assertEquals(Map.of(Items.COBBLESTONE, 3), nativeResume.current().floors());
        var route = new AgentWalkedRoute();
        route.restore(nativeResume.current().breadcrumbs());
        assertEquals(new BlockPos(-2, 28, 513).asLong(), route.next(new BlockPos(-3, 27, 513).asLong()));
    }
}
