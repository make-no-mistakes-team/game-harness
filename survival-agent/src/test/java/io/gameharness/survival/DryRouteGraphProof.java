package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.Retirement.*;
import static io.gameharness.survival.AgentRouteGraph.Status.*;
import static io.gameharness.survival.AgentRouteGraph.cell;

/** Exercises only the evidence and planning interface; no client or world is needed. */
public final class DryRouteGraphProof {
    public static void main(String[] args) {
        routesUpAndAwayToTheDeeperPerspective();
        distinguishesAnUntestedReverseFromARetiredReturn();
        keepsAWitnessedAlternativeAroundACut();
        neverJoinsDisconnectedWalksByProximity();
        scansAVisualFrontierOnlyOncePerProof();
        reconsidersNewLowerEvidenceAfterTheSelectedLook();
        prefersAnUnvisitedViewOnTheSameShelf();
        keepsTheGoalAcrossSegmentsAndNewOffers();
        choosesStableTiesIndependentOfObservationOrder();
        distinguishesBudgetExhaustionFromNoRoute();
        preservesReturnWhenObservationStorageFills();
    }

    private static void routesUpAndAwayToTheDeeperPerspective() {
        var graph = new AgentRouteGraph();
        long start = cell(0, 30, 0);
        long shallow = cell(0, 29, 1);
        long rise = cell(1, 31, 0);
        long bend = cell(1, 30, 1);
        long shelf = cell(1, 29, 2);
        long lower = cell(0, 28, 2);
        graph.reset(start);
        observedBothWays(graph, start, shallow);
        observedBothWays(graph, start, rise);
        observedBothWays(graph, rise, bend);
        observedBothWays(graph, bend, shelf);
        observedBothWays(graph, shelf, lower);
        graph.frontier(lower, 3);

        require(graph.plan(start) == MOVE && graph.next() == rise && graph.endpoint() == lower,
            "deepest useful stance first requires moving uphill and farther from it");
        require(graph.segmentSize() == 4 && graph.segmentCell(0) == rise && graph.segmentCell(3) == lower
            && graph.segmentCell(-1) == NO_CELL && graph.segmentCell(4) == NO_CELL,
            "expose just the exact remaining waypoints of the current segment");
        require(graph.plan(start) == MOVE && graph.next() == rise, "another frame does not advance the plan");
        require(graph.plan(rise) == MOVE && graph.next() == bend, "continue around the bend");
        require(graph.segmentSize() == 3 && graph.segmentCell(0) == bend, "a settled actual step advances the exposed segment");
        require(graph.plan(bend) == MOVE && graph.next() == shelf, "continue down toward the shelf");
        require(graph.plan(shelf) == MOVE && graph.next() == lower, "finish on the lower known footing");
        require(graph.plan(lower) == FRONTIER && graph.frontierBearing() == 3 && graph.next() == NO_CELL,
            "arrive at a lookout, not a step beyond it");
        require(graph.returnNext(lower) == shelf, "retain the independently witnessed ascent home");
    }

    private static void distinguishesAnUntestedReverseFromARetiredReturn() {
        var graph = new AgentRouteGraph();
        long start = cell(0, 30, 0);
        long shelf = cell(1, 29, 0);
        graph.reset(start);
        graph.observe(start, shelf);
        graph.frontier(shelf, 0);
        require(graph.plan(start) == NO_ROUTE, "a witnessed drop does not prove an ascent");
        require(graph.plan(shelf) == STRANDED, "an isolated settled stance has no witnessed return");
        require(graph.returnNext(shelf) == NO_CELL, "never invent the untested reverse");

        graph.observe(shelf, start);
        require(graph.plan(start) == MOVE && graph.next() == shelf, "separate ascent evidence certifies the shelf");
        require(graph.retire(shelf, start, OBSTRUCTION) && graph.segmentSize() == 0 && graph.segmentCell(0) == NO_CELL,
            "never expose an authorized segment after its proof changes");
        require(graph.reopen(shelf, start, OBSTRUCTION), "restore the first return cut");
        require(graph.plan(shelf) == FRONTIER && graph.returnNext(shelf) == start, "return proof is now usable");
        require(graph.retire(shelf, start, OBSTRUCTION), "retire only the obstructed direction");
        require(graph.usable(start, shelf) && graph.retirement(shelf, start) == OBSTRUCTION,
            "retirement preserves the other direction and concrete cause");
        require(!graph.observe(shelf, start) && !graph.reopen(shelf, start, LIGHT), "stale or unrelated evidence cannot reopen a cut");
        require(graph.plan(shelf) == STRANDED && graph.returnNext(shelf) == NO_CELL, "a blocked cut removes return proof");
        require(graph.reopen(shelf, start, OBSTRUCTION), "matching fresh evidence reopens the return");
        require(graph.plan(shelf) == FRONTIER && graph.returnNext(shelf) == start, "return proof is restored");
    }

    private static void keepsAWitnessedAlternativeAroundACut() {
        var graph = new AgentRouteGraph();
        long home = cell(0, -4, 0);
        long shelf = cell(1, -5, 0);
        long side = cell(1, -5, -1);
        long top = cell(0, -4, -1);
        graph.reset(home);
        graph.observe(shelf, home);
        graph.walked(shelf, side);
        graph.walked(side, top);
        graph.walked(top, home);
        require(graph.plan(shelf) == NO_ROUTE && graph.returnNext(shelf) == home,
            "there is initially a proved direct return, even without outbound work");
        graph.retire(shelf, home, HAZARD);
        require(!graph.canReturn(shelf), "a revised cut invalidates the old return proof until checked");
        require(graph.plan(shelf) == NO_ROUTE && graph.canReturn(shelf)
            && graph.returnNext(shelf) == side && graph.returnNext(side) == top && graph.returnNext(top) == home,
            "a cut cannot erase a genuinely walked, cardinal detour to the same anchor");
    }

    private static void neverJoinsDisconnectedWalksByProximity() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 30, 0);
        long visited = cell(1, 30, 0);
        long adjacent = cell(2, 30, 0);
        long oreView = cell(3, 29, 0);
        graph.reset(home);
        graph.walked(home, visited);
        graph.walked(visited, home);
        graph.walked(adjacent, oreView);
        graph.walked(oreView, adjacent);
        graph.goal(oreView, 5);
        require(graph.plan(home) == NO_ROUTE && !graph.usable(visited, adjacent), "recorded fragments do not join across adjacent cells");
        require(graph.contains(adjacent) && graph.plan(adjacent) == STRANDED && !graph.canReturn(adjacent),
            "a separate loop cannot substitute for return to the anchor");
        graph.walked(visited, adjacent);
        require(graph.plan(home) == NO_ROUTE, "one actual connecting traversal is still not a return");
        graph.walked(adjacent, visited);
        require(graph.plan(home) == MOVE && graph.next() == visited && graph.endpoint() == oreView,
            "two actual connecting traversals make the historic ore view reachable");
    }

    private static void scansAVisualFrontierOnlyOncePerProof() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 50, 0);
        graph.reset(home);
        require(!graph.frontier(cell(1, 50, 0), 0), "an unknown stance cannot host a visual frontier");
        require(graph.frontier(home, 2), "offer a new view at the known anchor");
        require(graph.plan(home) == FRONTIER && graph.next() == NO_CELL, "a frontier never creates a movement edge");
        require(graph.consumeFrontier(home, 2), "consume the bounded look");
        require(!graph.frontier(home, 2) && graph.plan(home) == NO_ROUTE, "the same old view cannot drive another cycle");
        require(graph.reopenFrontier(home, 2) && graph.plan(home) == FRONTIER, "a genuinely changed view can be inspected");
        require(graph.surveyed(home) && graph.plan(home) == NO_ROUTE, "a completed survey spends the offered views");
    }

    private static void reconsidersNewLowerEvidenceAfterTheSelectedLook() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 30, 0);
        long lower = cell(1, 29, 0);
        graph.reset(home);
        graph.frontier(home, 2);
        graph.frontier(home, 3);
        require(graph.plan(home) == FRONTIER && graph.frontierBearing() == 2, "commit to the source look");
        graph.frontier(home, 0);
        observedBothWays(graph, home, lower);
        graph.frontier(lower, 1);
        require(graph.consumeFrontier(home, 3) && graph.plan(home) == FRONTIER && graph.frontierBearing() == 2,
            "an unrelated look or newly offered bearing must not replace the active view");
        require(graph.consumeFrontier(home, 2) && graph.plan(home) == MOVE && graph.next() == lower,
            "the performed view releases its commitment so the new lower route wins over unperformed views");
        require(graph.consumeFrontier(home, 0) && graph.plan(home) == MOVE && graph.next() == lower,
            "consuming an unrelated view does not interrupt travel to the chosen endpoint");
    }

    private static void prefersAnUnvisitedViewOnTheSameShelf() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 30, 0);
        long onward = cell(1, 30, 0);
        graph.reset(home);
        observedBothWays(graph, home, onward);
        graph.frontier(home, 2);
        graph.frontier(onward, 3);
        require(graph.plan(home) == MOVE && graph.next() == onward,
            "prefer a genuinely new same-height perspective to another turn at the current footing");
        require(graph.plan(onward) == FRONTIER && graph.frontierBearing() == 3,
            "keep the committed viewpoint after knowing it was reached");
    }

    private static void keepsTheGoalAcrossSegmentsAndNewOffers() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 30, 0);
        long goal = cell(12, 30, 0);
        graph.reset(home);
        for (int x = 0; x < 12; x++) observedBothWays(graph, cell(x, 30, 0), cell(x + 1, 30, 0));
        graph.goal(goal, 1);
        require(graph.plan(home) == MOVE && graph.endpoint() == goal, "commit to the known goal anchor");
        require(graph.segmentSize() == 8 && graph.segmentCell(7) == cell(8, 30, 0) && graph.segmentCell(8) == NO_CELL,
            "a retained distant goal never exposes more than eight authorized hops");
        graph.goal(home, 2);
        for (int x = 0; x < 12; x++) {
            require(graph.plan(cell(x, 30, 0)) == MOVE
                && graph.next() == cell(x + 1, 30, 0) && graph.endpoint() == goal,
                "move toward the retained goal even after renewing the bounded segment");
        }
        require(graph.plan(goal) == GOAL && graph.next() == NO_CELL, "arrive exactly at the observed goal viewpoint");
    }

    private static void choosesStableTiesIndependentOfObservationOrder() {
        long home = cell(0, 30, 0);
        long west = cell(-1, 30, 0);
        long east = cell(1, 30, 0);
        var graph = new AgentRouteGraph();
        for (boolean westFirst : new boolean[] {true, false}) {
            graph.reset(home);
            observedBothWays(graph, home, westFirst ? west : east);
            observedBothWays(graph, home, westFirst ? east : west);
            graph.goal(west, 1);
            graph.goal(east, 1);
            require(graph.plan(home) == MOVE && graph.next() == west, "equal goals have a stable coordinate tie-break");
        }
    }

    private static void distinguishesBudgetExhaustionFromNoRoute() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 30, 0);
        long other = cell(1, 30, 0);
        graph.reset(home);
        observedBothWays(graph, home, other);
        require(graph.plan(home, 1) == LIMIT, "incomplete return proof is not an exhausted search");
        require(graph.plan(home) == NO_ROUTE, "an exhausted search with no endpoint proves no route to useful work");
    }

    private static void preservesReturnWhenObservationStorageFills() {
        var graph = new AgentRouteGraph();
        long home = cell(0, 30, 0);
        long next = cell(1, 30, 0);
        graph.reset(home);
        observedBothWays(graph, home, next);
        // Deliberately fill storage with a separate observed path.
        for (int x = 10; x < 150; x++) graph.observe(cell(x, 30, 4), cell(x + 1, 30, 4));
        require(graph.nodeCount() == 128 && graph.saturated() && graph.plan(next) == LIMIT,
            "omitted evidence is not a proof of no route");
        require(graph.returnNext(next) == home, "retaining observations must not evict a safe return spine");
    }

    private static void observedBothWays(AgentRouteGraph graph, long a, long b) {
        graph.observe(a, b);
        graph.observe(b, a);
    }

    private static void require(boolean condition, String why) {
        if (!condition) throw new AssertionError(why);
    }
}
