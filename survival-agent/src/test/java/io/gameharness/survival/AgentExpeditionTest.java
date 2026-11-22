package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class AgentExpeditionTest {
    private static final String RUN = "survival.R1", GOAL = "diamond";
    private static final String ID = "113cc5bb-2d89-4e43-86be-7dd2cc051220";
    private static final AgentExpedition.Option SCOUT = new AgentExpedition.Option("scout", "Survey exposed ore.");
    private static final AgentExpedition.Option STAIR = new AgentExpedition.Option("stair", "Cut a returnable staircase.");

    @TempDir Path temporary;

    @Test void privateMailboxBindsAdviceToAnActuallyPublishedOpportunity() throws IOException {
        Path run = temporary.resolve(RUN);
        Files.createDirectory(run);
        Path expedition = Files.createDirectory(run.resolve("expedition"),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Path active = expedition.resolve("active.json");
        Files.writeString(active, "{\"v\":1,\"run\":\"" + RUN + "\"}");
        Files.setPosixFilePermissions(active, PosixFilePermissions.fromString("rw-r--r--"));
        assertNull(AgentExpedition.Transport.open(run, GOAL));
        Files.setPosixFilePermissions(active, PosixFilePermissions.fromString("rw-------"));
        var transport = AgentExpedition.Transport.open(run, GOAL);
        assertTrue(transport.active());
        var offer = new AgentExpedition.Offer("ore_route", SCOUT, STAIR);
        Path advice = expedition.resolve("advice.json");
        writeAdvice(advice, 40, 940, "stair");
        assertNull(transport.readAdvice()); // Shape-valid is not evidence that tick 40 was published.
        var inventory = new JsonObject();
        inventory.addProperty("minecraft:torch", 24);
        transport.publish(new AgentExpedition.Snapshot(1, 40, offer, inventory, 16, 18, "Looking for exposed ore.", null));
        Path state = expedition.resolve("state.json");
        var published = JsonParser.parseString(Files.readString(state)).getAsJsonObject();
        assertEquals(Set.of("v", "run", "life", "goal", "tick", "need", "options", "inventory", "health", "food", "activity"),
            published.keySet());
        assertEquals(GOAL, published.get("goal").getAsString());
        assertEquals(24, published.getAsJsonObject("inventory").get("minecraft:torch").getAsInt());
        assertEquals(2, published.getAsJsonArray("options").size());
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(state)));
        var candidate = transport.readAdvice();
        assertSame(STAIR, candidate.option());
        var otherOffer = new AgentExpedition.Offer("ore_route", SCOUT, STAIR);
        assertFalse(candidate.current(1, 41, otherOffer)); // Same advertised strings, different opportunity.
        assertFalse(candidate.current(2, 41, offer));
        assertFalse(candidate.current(1, 39, offer));
        assertTrue(candidate.current(1, 940, offer));
        assertFalse(candidate.current(1, 941, offer));
        Path extraLink = Files.createLink(expedition.resolve("extra-advice-link"), advice);
        assertNull(transport.readAdvice());
        Files.delete(extraLink);
        writeAdvice(advice, 40, 940, "unoffered");
        assertNull(transport.readAdvice());
        writeAdvice(advice, 40, 1241, "stair");
        assertNull(transport.readAdvice());
        writeAdvice(advice, 40, 40, "stair");
        assertNull(transport.readAdvice());
    }

    @Test void recommendationNeverConsumesProtectedWorkOrReopensAnOpportunity() {
        var offer = new AgentExpedition.Offer("ore_route", SCOUT, STAIR);
        var choice = new AgentExpedition.Choice();
        var advice = new AgentExpedition.Candidate(1, 40, 940, ID, offer, STAIR, null);
        assertNull(choice.take(null, 1, 43, offer, true)); // No model answer does not reserve anything.
        assertNull(choice.take(advice, 1, 44, offer, false));
        assertNull(choice.applied());
        assertSame(STAIR, choice.take(advice, 1, 45, offer, true));
        assertEquals(new AgentExpedition.Applied(ID, "stair", 45), choice.applied());
        var changedMind = new AgentExpedition.Candidate(1, 40, 940,
            "577fdde1-bc18-47b1-a239-a7eddb91cade", offer, SCOUT, null);
        assertNull(choice.take(changedMind, 1, 46, offer, true));
        var secondOffer = new AgentExpedition.Offer("another_route", SCOUT, STAIR);
        assertSame(SCOUT, choice.take(new AgentExpedition.Candidate(1, 45, 945,
            "929a1488-63c5-431b-adfd-4eaa569a79fe", secondOffer, SCOUT, null), 1, 46, secondOffer, true));
        assertNull(choice.take(changedMind, 1, 47, offer, true));
        choice.reset();
        assertNull(choice.applied());
        var nextOffer = new AgentExpedition.Offer("ore_route", SCOUT, STAIR);
        assertNull(choice.take(new AgentExpedition.Candidate(2, 80, 980, ID, nextOffer, STAIR, null),
            2, 85, nextOffer, true));
    }

    @Test void recoveryAdviceNeedsAnAuthoredSubgoalAndOnlyAdvertisedDistinctMethods() throws IOException {
        Path run = Files.createDirectory(temporary.resolve(RUN));
        Path directory = Files.createDirectory(run.resolve("expedition"),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        Files.createFile(directory.resolve("active.json"),
            PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        Files.writeString(directory.resolve("active.json"), "{\"v\":1,\"run\":\"" + RUN + "\"}");
        var transport = AgentExpedition.Transport.open(run, GOAL);
        var recovery = new AgentExpedition.Recovery(7, List.of("The retry did not produce settled work."));
        var offer = new AgentExpedition.Offer(recovery, List.of(SCOUT, STAIR));
        transport.publish(new AgentExpedition.Snapshot(1, 40, offer, new JsonObject(), 20, 20, "Recovering.", null));
        var state = JsonParser.parseString(Files.readString(directory.resolve("state.json"))).getAsJsonObject();
        assertEquals("situational_recovery", state.get("need").getAsString());
        assertEquals(7, state.getAsJsonObject("recovery").get("incident").getAsInt());
        assertEquals(1, state.getAsJsonObject("recovery").getAsJsonArray("history").size());
        Path advice = directory.resolve("advice.json");
        Files.createFile(advice, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
        for (String invalid : List.of("", ",\"subgoal\":\"  \",\"steps\":[\"scout\"]",
                ",\"subgoal\":\"Check new footing\",\"steps\":[\"scout\",\"scout\"]",
                ",\"subgoal\":\"Check new footing\",\"steps\":[\"scout\",\"unoffered\"]",
                ",\"subgoal\":\"Check new footing\",\"steps\":[\"stair\",\"scout\"]",
                ",\"subgoal\":\"" + "é".repeat(121) + "\",\"steps\":[\"scout\"]")) {
            writeRecoveryAdvice(advice, invalid);
            assertNull(transport.readAdvice());
        }
        writeRecoveryAdvice(advice, ",\"subgoal\":\"Find drier ground before trying a new dig\",\"steps\":[\"scout\",\"stair\"]");
        var candidate = transport.readAdvice();
        assertEquals("Find drier ground before trying a new dig", candidate.recovery().subgoal());
        assertEquals(List.of(SCOUT, STAIR), candidate.recovery().steps());
        assertFalse(candidate.current(1, 43, new AgentExpedition.Offer(recovery, List.of(SCOUT, STAIR))));

        var single = new AgentExpedition.Offer(new AgentExpedition.Recovery(8, recovery.history()), List.of(SCOUT));
        transport.publish(new AgentExpedition.Snapshot(1, 40, single, new JsonObject(), 20, 20, "Recovering.", null));
        assertNull(transport.readAdvice());
        writeRecoveryAdvice(advice, ",\"subgoal\":\"Try one new sightline\",\"steps\":[\"scout\"]");
        assertEquals(List.of(SCOUT), transport.readAdvice().recovery().steps());
    }

    private static void writeRecoveryAdvice(Path path, String extra) throws IOException {
        Files.writeString(path, """
            {"v":1,"run":"%s","life":1,"goal":"%s","id":"%s","basisTick":40,
            "expiresTick":940,"need":"situational_recovery","option":"scout"%s}
            """.formatted(RUN, GOAL, ID, extra));
    }

    @Test void publishingAndAbstainingLeaveTheLocalRouteInControl() {
        var route = new AgentExpedition.Prospecting("diamond_route");
        var offer = route.live();
        assertEquals("diamond_route", offer.need);
        assertEquals(AgentExpedition.Prospecting.Turn.LOCAL, route.turn(100));
        // The ordinary worker can already be in a mine, on a supply walk or
        // approaching a cave when the answer eventually arrives.
        route.choose(null, 200, false);
        assertSame(offer, route.live());
        assertEquals(AgentExpedition.Prospecting.Turn.LOCAL, route.turn(200));
        assertEquals(AgentExpedition.Prospecting.Turn.LOCAL, route.turn(1000));
    }

    @Test void appliedOreStrategyOwnsOnlyItsNextLegOrThreeUndergroundViews() {
        var stair = new AgentExpedition.Prospecting("diamond_route");
        stair.choose(AgentExpedition.Prospecting.STAIR, 150, false);
        assertNull(stair.live());
        assertEquals(AgentExpedition.Prospecting.Turn.EXCAVATE, stair.turn(150));
        assertEquals(AgentExpedition.Prospecting.Turn.LOCAL, stair.turn(151));

        var scout = new AgentExpedition.Prospecting("diamond_route");
        scout.choose(AgentExpedition.Prospecting.VISIBLE, 150, false);
        for (int view = 0; view < 3; ++view) {
            assertEquals(AgentExpedition.Prospecting.Turn.SCOUT, scout.turn(150 + view));
            assertEquals(view, scout.view());
            scout.sawView();
        }
        assertEquals(AgentExpedition.Prospecting.Turn.LOCAL, scout.turn(154));
        assertNull(scout.live());

        var missingFrame = new AgentExpedition.Prospecting("iron_route");
        missingFrame.choose(AgentExpedition.Prospecting.VISIBLE, 150, false);
        assertEquals(AgentExpedition.Prospecting.Turn.LOCAL, missingFrame.turn(260));
    }

    private static void writeAdvice(Path path, long basis, long expires, String option) throws IOException {
        Files.writeString(path, """
            {"v":1,"run":"%s","life":1,"goal":"%s","id":"%s","basisTick":%d,
            "expiresTick":%d,"need":"ore_route","option":"%s"}
            """.formatted(RUN, GOAL, ID, basis, expires, option));
        Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
    }
}
