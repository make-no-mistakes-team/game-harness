package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.cell;
import static org.junit.jupiter.api.Assertions.*;

import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class WalkedRouteTest {
    @BeforeAll
    static void initializeVanilla() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
    }

    @Test
    void canRecallOutOfSightThroughPreplacementLegsAndHeightChanges() {
        var route = new AgentWalkedRoute();
        long entry = cell(-4, -13, -2), middle = cell(-3, -12, -2), furnace = cell(-3, -12, -1);
        route.landed(entry, middle);
        route.landed(middle, furnace);
        route.anchor(furnace);
        long shelf = cell(-2, -13, -1);
        route.landed(furnace, shelf);
        long end = shelf;
        for (int x = -1; x <= 12; x++) {
            long next = cell(x, -13, -1);
            route.landed(end, next);
            end = next;
        }

        assertEquals(middle, route.next(entry));
        assertEquals(furnace, route.next(middle));
        assertEquals(cell(11, -13, -1), route.next(end));
        assertEquals(furnace, route.next(shelf));
        var saved = route.breadcrumbs(end);
        assertTrue(AgentWalkedRoute.validBreadcrumbs(saved, -3, -12, 0));
        assertEquals(15, saved.edges().length);
        var child = new AgentWalkedRoute();
        child.restore(saved);
        assertEquals(cell(11, -13, -1), child.next(end));
        assertEquals(furnace, child.next(shelf));
        assertFalse(child.connected(entry)); // An unrelated branch didn't come with the saved return.
    }

    @Test
    void refusesDisconnectedDiagonalAndFallLinksUntilRealRejoin() {
        var route = new AgentWalkedRoute();
        long station = cell(0, 16, 0), landing = cell(1, 15, 0), afterGap = cell(2, 15, 0);
        route.anchor(station);
        route.landed(station, landing);
        route.landed(afterGap, cell(3, 15, 0));
        route.landed(station, cell(0, 12, 1)); // Fall.
        route.landed(landing, cell(2, 15, 1)); // Ambiguous diagonal.
        assertEquals(NO_CELL, route.next(afterGap));
        assertFalse(route.connected(cell(0, 12, 1)));
        assertFalse(route.connected(cell(2, 15, 1)));
        route.landed(afterGap, landing);
        assertEquals(landing, route.next(afterGap));
    }

    @Test
    void aProvedChangeCutsOnlyItsOwnBranchAndNewLifeForgetsTheOldRoute() {
        var route = new AgentWalkedRoute();
        long start = cell(0, 18, 0), split = cell(1, 18, 0), wet = cell(1, 17, 1), dry = cell(2, 18, 0);
        route.anchor(start);
        route.landed(start, split);
        route.landed(split, wet);
        route.landed(split, dry);
        route.rejected(split, wet);
        assertEquals(NO_CELL, route.next(wet));
        assertEquals(split, route.next(dry));
        route.landed(wet, split); // Actual fresh dry traverse may renew the old edge.
        assertEquals(split, route.next(wet));
        route.clear();
        route.anchor(start);
        assertFalse(route.connected(wet));
        assertFalse(route.connected(dry));
        route.anchor(dry); // A newly witnessed exact local station also works without an old path.
        assertTrue(route.connected(dry));
        assertEquals(NO_CELL, route.next(start));
    }

    @Test
    void evictionPreservesTheStationAndImmediateWitnessButNeverSynthesizesAGap() {
        var route = new AgentWalkedRoute();
        long station = cell(0, 30, 0), step = cell(1, 30, 0);
        route.landed(station, step);
        route.anchor(station);
        for (int x = 1; x <= AgentWalkedRoute.LIVE_EDGES * 2; x++)
            route.landed(cell(x, 30, 0), cell(x + 1, 30, 0));
        assertTrue(route.connected(station));
        assertEquals(station, route.next(step));
        assertEquals(NO_CELL, route.next(cell(100, 30, 0)));
        assertNull(route.breadcrumbs(cell(100, 30, 0)));
    }

    @Test
    void closedSaveLimitDoesNotLimitLiveRecallToTheNextRetainedLeg() {
        var route = new AgentWalkedRoute();
        route.anchor(cell(0, 30, 0));
        for (int x = 0; x < AgentWalkedRoute.SAVED_EDGES + 1; x++)
            route.landed(cell(x, 30, 0), cell(x + 1, 30, 0));
        long beyond = cell(AgentWalkedRoute.SAVED_EDGES + 1, 30, 0);
        long atLimit = cell(AgentWalkedRoute.SAVED_EDGES, 30, 0);
        assertEquals(atLimit, route.next(beyond));
        assertNull(route.breadcrumbs(beyond)); // Never save a disconnected suffix.
        assertEquals(AgentWalkedRoute.SAVED_EDGES, route.breadcrumbs(atLimit).edges().length);
    }

    @Test
    void discontinuityCannotBeMadeIntoTraversalByLaterMotion() {
        var motion = new AgentWalkedRoute.Motion();
        motion.start(0.5, 30, 0.5);
        assertTrue(motion.observe(0.65, 30, 0.5));
        assertFalse(motion.traversed());
        assertFalse(motion.observe(1.5, 30, 0.5));
        motion.observe(1.6, 30, 0.5);
        motion.observe(1.7, 30, 0.5);
        assertFalse(motion.traversed());
        motion.start(0.5, 30, 0.5);
        motion.observe(0.75, 30.4, 0.5);
        motion.observe(1, 30.75, 0.5);
        motion.observe(1.25, 31.1, 0.5);
        assertTrue(motion.observe(1.5, 31, 0.5));
        assertTrue(motion.traversed());
    }

    @Test
    void successiveProvedProspectStepsKeepTheirHeadingWithoutSpendingALook() {
        var route = new AgentMacroControl.DiamondRoute();
        var start = new BlockPos(0, 31, 0);
        route.arrive(start, Blocks.STONE.getDefaultState(), Direction.EAST);
        for (int i = 0; i < 2; i++) {
            var leg = dryLeg(start.offset(Direction.EAST, i), start.offset(Direction.EAST, i + 1), Direction.EAST);
            var offer = new AgentDryCaveRoute.Offer(leg.upper(), leg.lower(), leg.lower(), 1);
            assertEquals(Direction.EAST, route.naturalBearing(offer, floor -> false));
            assertFalse(route.glanced, "already witnessed travel does not spend a stationary look");
            route.advance(leg);
            assertEquals(Direction.EAST, route.preferred);
        }
        assertEquals(start.east(2), route.foot);
        assertEquals(2, route.spine.size(), "each actual crossing retains a separate physical return");
    }

    @Test
    void prospectPrefixRequiresEachIntermediateSupportToBeAvailable() {
        var route = new AgentMacroControl.DiamondRoute();
        var start = new BlockPos(0, 31, 0);
        route.arrive(start, Blocks.STONE.getDefaultState(), Direction.EAST);
        var offer = new AgentDryCaveRoute.Offer(start, start.east(), start.east(3), 3);
        assertEquals(Direction.EAST, route.naturalBearing(offer, floor -> false));
        assertNull(route.naturalBearing(offer, start.east(2).down()::equals),
            "a witnessed endpoint cannot authorize bypassing an unconfirmed landing in the middle");
    }

    @Test
    void renewingAtTheSameProspectFootingCannotRepeatAnUnprovedOrUnsafeLane() {
        var route = new AgentMacroControl.DiamondRoute();
        var start = new BlockPos(0, 31, 0);
        var floor = Blocks.STONE.getDefaultState();
        var down = start.east().down();
        var offer = new AgentDryCaveRoute.Offer(start, down, down, 1);
        route.arrive(start, floor, Direction.EAST);
        route.glanced = true;
        route.refuseCurrent("The lower lane did not prove safe.");
        route.arrive(start, floor, Direction.NORTH);
        assertNull(route.naturalBearing(offer, cell -> false));
        assertTrue(route.glanced, "policy renewal isn't a new physical look opportunity");
        var level = start.east();
        assertEquals(Direction.EAST, route.naturalBearing(new AgentDryCaveRoute.Offer(start, level, level, 1),
            cell -> false), "a different, proved same-level lane can still be considered");
    }

    @Test
    void refusedDiamondReturnCanStartAgainAfterASeparateCompletedWalkWithoutAdoptingTheBrokenSpine() {
        var walked = new AgentWalkedRoute();
        var route = new AgentMacroControl.DiamondRoute();
        var failure = dryLeg(new BlockPos(0, 32, 0), new BlockPos(1, 31, 0), Direction.EAST);
        route.arrive(failure.upper(), failure.upperSupport(), Direction.EAST);
        route.advance(failure);
        route.treads = 3;
        route.interruptedAt(failure.lower(), failure);

        // The prospective job that already held the controls cannot later acquire a new witness.
        long previousGrant = walked.recovery().proof();
        var exactReturn = dryLeg(new BlockPos(2, 30, 0), new BlockPos(2, 31, 1), Direction.SOUTH);
        Object recall = new Object();
        begin(walked, recall, exactReturn.upper());
        land(walked, exactReturn);
        assertFalse(reanchor(route, walked, previousGrant, exactReturn.lower()));
        finish(walked, recall, true, exactReturn.lower());
        assertFalse(reanchor(route, walked, previousGrant, exactReturn.lower()));

        long freshGrant = walked.recovery().proof();
        assertTrue(reanchor(route, walked, freshGrant, exactReturn.lower()));
        assertEquals(exactReturn.lower(), route.foot);
        assertEquals(exactReturn, route.rootExit);
        assertNull(route.unjoined);
        assertTrue(route.spine.isEmpty());
        assertTrue(route.supports.contains(failure.upper().down()));
        assertTrue(route.supports.contains(failure.lower().down()));
        assertTrue(route.supports.contains(exactReturn.upper().down()));
        assertEquals(3, route.treads);
    }

    @Test
    void independentlyRetracedPathRejoinsOnlyTheCurrentPrefixAndCanLandAtTheDisplacedCell() {
        var walked = new AgentWalkedRoute();
        var route = new AgentMacroControl.DiamondRoute();
        var root = new BlockPos(0, 31, 0);
        var intersection = root.east();
        var wrongReverse = dryLeg(intersection, intersection.east(), Direction.EAST);
        var oldPrefix = dryLeg(root, intersection, Direction.EAST);
        route.arrive(root, oldPrefix.upperSupport(), Direction.EAST);
        route.advance(oldPrefix);
        route.advance(wrongReverse);
        route.interruptedAt(wrongReverse.lower(), wrongReverse);

        // Both ordinary actions succeeded. Rejoining can keep root->intersection, not the failed edge.
        var detour = dryLeg(intersection, intersection.south(), Direction.SOUTH);
        var home = dryLeg(detour.lower(), detour.lower().east(), Direction.EAST);
        var arrival = dryLeg(home.lower(), wrongReverse.lower(), Direction.NORTH);
        Object first = new Object();
        begin(walked, first, intersection);
        land(walked, detour);
        land(walked, home);
        finish(walked, first, true, home.lower());
        Object last = new Object();
        begin(walked, last, home.lower());
        land(walked, arrival);
        finish(walked, last, true, arrival.lower());
        assertTrue(reanchor(route, walked, walked.recovery().proof(), wrongReverse.lower()));
        assertEquals(4, route.spine.size());
        route.returnOne();
        assertEquals(home.lower(), route.foot);
        route.returnOne();
        assertEquals(detour.lower(), route.foot);
        route.returnOne();
        assertEquals(intersection, route.foot);
        route.returnOne();
        assertEquals(root, route.foot);
    }

    @Test
    void stationaryRecallAbortedTravelAndRestoredOrDiscontinuousLinksCannotMintAProspectGrant() {
        var walked = new AgentWalkedRoute();
        var from = new BlockPos(0, 31, 0);
        var leg = dryLeg(from, from.east(), Direction.EAST);
        Object look = new Object(), abort = new Object(), teleport = new Object();
        begin(walked, look, from);
        walked.recovery().finish(look, true, from, leg.upperSupport(), Vec3d.ofBottomCenter(from).add(0.1, 0, 0));
        assertEquals(0, walked.recovery().proof());

        begin(walked, abort, from);
        land(walked, leg);
        finish(walked, abort, false, leg.lower());
        assertEquals(0, walked.recovery().proof());

        walked.restore(new AgentWalkedRoute.Breadcrumbs(new int[] {1, 31, 0},
            new int[][] {{0, 31, 0, 1, 31, 0}}));
        begin(walked, teleport, from);
        land(walked, dryLeg(from, from.east().south(), Direction.EAST));
        finish(walked, teleport, true, from.east().south());
        assertEquals(0, walked.recovery().proof());
        assertEquals(leg.lower().asLong(), walked.next(from.asLong()));
    }

    @Test
    void aDryArrivalStillNeedsTheSameSupportAndALiveReverseLane() {
        var walked = new AgentWalkedRoute();
        var route = new AgentMacroControl.DiamondRoute();
        var leg = dryLeg(new BlockPos(0, 31, 0), new BlockPos(1, 31, 0), Direction.EAST);
        var foot = leg.lower();
        var feet = Vec3d.ofBottomCenter(foot);
        route.arrive(leg.upper(), leg.upperSupport(), Direction.EAST);
        route.interruptedAt(leg.upper(), null);
        Object action = new Object();
        begin(walked, action, leg.upper());
        land(walked, leg);
        finish(walked, action, true, foot);
        long witness = walked.recovery().proof();
        var path = walked.recovery().path(witness, foot, leg.lowerSupport(), feet);
        assertFalse(route.reanchor(foot, leg.lowerSupport(), Direction.EAST, path, edge -> false, edge -> true));
        assertFalse(route.reanchor(foot, leg.lowerSupport(), Direction.EAST, path, edge -> true, edge -> false));
        assertTrue(walked.recovery().path(witness, foot, Blocks.DEEPSLATE.getDefaultState(), feet).isEmpty());
        assertFalse(reanchor(route, walked, witness, foot)); // Restoring the old block cannot restore the receipt.

        begin(walked, action, leg.upper());
        land(walked, leg);
        finish(walked, action, true, foot);
        witness = walked.recovery().proof();
        walked.recovery().observe(foot.down(), null, feet.add(0, -1, 0));
        assertFalse(reanchor(route, walked, witness, foot)); // Neither can falling, then being moved back.
        assertNotNull(route.unjoined);
    }

    private static AgentSurfaceTread.Edge dryLeg(BlockPos from, BlockPos to, Direction travel) {
        var stone = Blocks.STONE.getDefaultState();
        return new AgentSurfaceTread.Edge(from, stone, to, stone, travel);
    }

    private static void begin(AgentWalkedRoute walked, Object action, BlockPos from) {
        walked.recovery().begin(action, from, Blocks.STONE.getDefaultState(), Vec3d.ofBottomCenter(from));
    }

    private static void land(AgentWalkedRoute walked, AgentSurfaceTread.Edge leg) {
        walked.landed(leg.upper(), leg.upperSupport(), leg.lower(), leg.lowerSupport(), leg.down());
    }

    private static void finish(AgentWalkedRoute walked, Object action, boolean success, BlockPos foot) {
        walked.recovery().finish(action, success, foot, Blocks.STONE.getDefaultState(), Vec3d.ofBottomCenter(foot));
    }

    private static boolean reanchor(AgentMacroControl.DiamondRoute route, AgentWalkedRoute walked, long grant, BlockPos foot) {
        var support = Blocks.STONE.getDefaultState();
        return route.reanchor(foot, support, Direction.EAST,
            walked.recovery().path(grant, foot, support, Vec3d.ofBottomCenter(foot)), edge -> true, edge -> true);
    }
}
