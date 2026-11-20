package io.gameharness.survival;

import java.util.Arrays;

/**
 * Bounded directed memory of admitted dry footing. The caller attests geometry or
 * consecutive settled contacts; this class never observes or drives the player.
 */
final class AgentRouteGraph {
    // Outside the playable coordinate range, with the same packing as BlockPos.
    static final long NO_CELL = Long.MIN_VALUE;
    private static final int MAX_NODES = 128;
    private static final int MAX_SEGMENT = 8;
    private static final int SLOTS = 12; // Four cardinal directions, three heights each.
    private static final int EDGE_STORAGE = (MAX_NODES + 1) * SLOTS;

    // NO_ROUTE exhausts known work; STRANDED has no witnessed return; LIMIT proves neither.
    enum Status { MOVE, FRONTIER, GOAL, NO_ROUTE, STRANDED, LIMIT }
    enum Retirement { OBSERVATION, LIGHT, OBSTRUCTION, HAZARD, EXECUTION, RESOURCES }
    private enum Work { LOWER, FRONTIER, GOAL }

    // Node zero is absent. Slots locate attested edges, never imply adjacency.
    private final long[] cells = new long[MAX_NODES + 1];
    private final short[] index = new short[2 * MAX_NODES];
    private final short[] outgoing = new short[EDGE_STORAGE];
    private final short[] incoming = new short[EDGE_STORAGE];
    private final Retirement[] retired = new Retirement[EDGE_STORAGE];
    private final boolean[] traveled = new boolean[EDGE_STORAGE];
    private final boolean[] reached = new boolean[MAX_NODES + 1];
    private final int[] goals = new int[MAX_NODES + 1];
    private final short[] seenViews = new short[MAX_NODES + 1];
    private final short[] openViews = new short[MAX_NODES + 1];

    private final short[] homeward = new short[MAX_NODES + 1];
    private final short[] queue = new short[MAX_NODES];
    private final short[] distance = new short[MAX_NODES + 1];
    private final short[] parent = new short[MAX_NODES + 1];
    private final short[] segment = new short[MAX_SEGMENT];
    private int count, edges, anchor, revision, topology;
    private int returnTopology = -1, segmentTopology;
    private boolean saturated;

    private int lastStance, target, cursor, length, selectedBearing = -1;
    private Work work;
    private int closedAt, closedRevision = -1;
    private Status closedStatus, status = Status.NO_ROUTE;

    static long cell(int x, int y, int z) {
        return ((x & 0x3ffffffL) << 38) | ((z & 0x3ffffffL) << 12) | (y & 0xfffL);
    }

    void reset(long anchorCell) {
        Arrays.fill(index, (short) 0);
        Arrays.fill(outgoing, (short) 0);
        Arrays.fill(incoming, (short) 0);
        Arrays.fill(retired, null);
        Arrays.fill(traveled, false);
        Arrays.fill(reached, false);
        Arrays.fill(goals, 0);
        Arrays.fill(seenViews, (short) 0);
        Arrays.fill(openViews, (short) 0);
        count = edges = revision = topology = 0;
        lastStance = closedAt = 0;
        returnTopology = closedRevision = -1;
        saturated = false;
        anchor = anchorCell == NO_CELL ? 0 : addCell(anchorCell);
        reached[anchor] = anchor != 0;
        cancelPlan();
    }

    boolean observe(long from, long to) {
        return attest(from, to, false);
    }

    boolean walked(long from, long to) {
        return attest(from, to, true);
    }

    private boolean attest(long from, long to, boolean actualTraversal) {
        int slot = slot(from, to);
        if (anchor == 0 || slot < 0) return false;
        int a = find(from), b = find(to);
        if (count + (a == 0 ? 1 : 0) + (b == 0 ? 1 : 0) > MAX_NODES) {
            // Keep the established return spine; omitted evidence makes exhaustion inconclusive.
            if (!saturated) {
                saturated = true;
                revision++;
            }
            return false;
        }
        if (a == 0) a = addCell(from);
        if (b == 0) b = addCell(to);
        int edge = a * SLOTS + slot;
        boolean changed = false;
        if (outgoing[edge] == 0 || actualTraversal && retired[edge] != null) {
            open(a, slot, b);
            changed = true;
        }
        if (actualTraversal && !traveled[edge]) {
            traveled[edge] = true;
            changed = true;
        }
        if (actualTraversal) {
            changed |= markReached(a);
            changed |= markReached(b);
        }
        return changed;
    }

    boolean usable(long from, long to) {
        int edge = edge(from, to);
        return edge >= 0 && retired[edge] == null;
    }

    Retirement retirement(long from, long to) {
        int edge = edge(from, to);
        return edge < 0 ? null : retired[edge];
    }

    boolean retire(long from, long to, Retirement reason) {
        int edge = edge(from, to);
        if (edge < 0 || reason == null || retired[edge] != null) return false;
        retired[edge] = reason;
        incoming[outgoing[edge] * SLOTS + opposite(edge % SLOTS)] = 0;
        edges--;
        topology++;
        revision++;
        return true;
    }

    /** Relevant new evidence must address the recorded cause; a newer frame alone need not. */
    boolean reopen(long from, long to, Retirement reason) {
        int edge = edge(from, to);
        if (edge < 0 || reason == null || retired[edge] != reason) return false;
        open(edge / SLOTS, edge % SLOTS, outgoing[edge]);
        return true;
    }

    void goal(long cell, int priority) {
        int node = find(cell);
        int value = Math.max(0, priority);
        if (node == 0 || goals[node] == value) return;
        goals[node] = value;
        revision++;
    }

    boolean frontier(long cell, int bearing) {
        return changeView(cell, bearing, false);
    }

    /** Reoffer a spent view only after new evidence specific to this perspective. */
    boolean reopenFrontier(long cell, int bearing) {
        return changeView(cell, bearing, true);
    }

    private boolean changeView(long cell, int bearing, boolean reopen) {
        int node = find(cell);
        int bit = viewBit(bearing);
        if (node == 0 || bit == 0 || ((seenViews[node] & bit) != 0) != reopen
            || (openViews[node] & bit) != 0) return false;
        seenViews[node] |= bit;
        openViews[node] |= bit;
        revision++;
        return true;
    }

    boolean consumeFrontier(long cell, int bearing) {
        int node = find(cell);
        int bit = viewBit(bearing);
        if (!reached[node] || (openViews[node] & bit) == 0) return false;
        openViews[node] &= ~bit;
        revision++;
        // A performed look completes just that job, not every pending look from this footing.
        if (node == target && node == lastStance && status == Status.FRONTIER && bearing == selectedBearing)
            cancelPlan();
        return true;
    }

    boolean surveyed(long cell) {
        int node = find(cell);
        if (!reached[node] || openViews[node] == 0) return false;
        openViews[node] = 0;
        revision++;
        return true;
    }

    int nodeCount() { return count; }
    int edgeCount() { return edges; }
    int topologyEpoch() { return topology; }
    boolean contains(long cell) { return find(cell) != 0; }
    boolean saturated() { return saturated; }

    void cancelPlan() {
        clearTarget();
        status = Status.NO_ROUTE;
    }

    /** Only pass a dry, settled real stance. Repeating a frame cannot advance a step. */
    Status plan(long current) {
        return plan(current, MAX_NODES);
    }

    Status plan(long current, int expansions) {
        int here = find(current);
        if (here == 0) return stop(saturated ? Status.LIMIT : Status.STRANDED);
        markReached(here);
        if (here != lastStance) {
            if (cursor < length && segment[cursor] == here) cursor++;
            else clearTarget();
            lastStance = here;
        }

        int budget = Math.max(0, Math.min(expansions, MAX_NODES));
        int spent = proveReturn(budget);
        if (spent < 0) return status = Status.LIMIT;
        if (homeward[here] == 0) return stop(saturated ? Status.LIMIT : Status.STRANDED);
        if (target != 0) {
            if (here == target) {
                if (work == Work.GOAL && goals[here] > 0) return status = Status.GOAL;
                if (work == Work.FRONTIER && openViews[here] != 0) return status = selectView(here);
                clearTarget();
            } else if (homeward[target] == 0 || work == Work.GOAL && goals[target] == 0
                || work == Work.FRONTIER && openViews[target] == 0
                || work == Work.LOWER && reached[target]) {
                clearTarget();
            } else if (cursor < length && (segmentTopology == topology || safeSuffix(here))) {
                segmentTopology = topology;
                return status = Status.MOVE;
            }
        }
        if (closedAt == here && closedRevision == revision) return status = closedStatus;
        return status = search(here, budget - spent);
    }

    long next() {
        return segmentCell(0);
    }

    int segmentSize() {
        return status == Status.MOVE && segmentTopology == topology ? length - cursor : 0;
    }

    long segmentCell(int offset) {
        return offset >= 0 && offset < segmentSize() ? cells[segment[cursor + offset]] : NO_CELL;
    }

    /** A direct grant can change height only on its first, separately revalidated edge. */
    int directPrefixSize(long source, int maximum) {
        int size = Math.min(segmentSize(), maximum);
        if (size <= 0 || lastStance != find(source)) return 0;
        int count = 0;
        long from = source;
        while (count < size) {
            long to = segmentCell(count);
            if (!canReturn(from) || !canReturn(to) || !usable(from, to) || !usable(to, from)) break;
            if (y(from) != y(to)) return count == 0 ? 1 : count;
            ++count;
            from = to;
        }
        return count;
    }

    /** Refresh only the granted suffix, never select alternate hops for its owner. */
    boolean revalidateDirectSuffix(long source, long[] hops, int start, int end) {
        if (start < 0 || end > hops.length || start >= end || anchor == 0 || proveReturn(MAX_NODES) < 0) return false;
        for (int i = start; i < end; ++i) {
            long to = hops[i];
            if (!canReturn(source) || !canReturn(to) || !usable(source, to) || !usable(to, source)) return false;
            source = to;
        }
        return true;
    }

    /** A missed render is neutral only if the current tick still belongs to the exact lease. */
    enum DirectTurn {
        DRIVE, HOLD, LOST_OWNER, LOST_VIEW;

        static DirectTurn classify(boolean sameLease, int previousTick, int tick, boolean freshView, int missedViews) {
            if (!sameLease || tick != previousTick + 1) return LOST_OWNER;
            if (freshView) return DRIVE;
            return missedViews < 2 ? HOLD : LOST_VIEW;
        }
    }

    long endpoint() {
        return status == Status.MOVE || status == Status.FRONTIER || status == Status.GOAL ? cells[target] : NO_CELL;
    }

    int frontierBearing() {
        return status == Status.FRONTIER && (openViews[target] & viewBit(selectedBearing)) != 0
            ? selectedBearing : -1;
    }

    /** Whether the last completed return search can certify this footing. */
    boolean canReturn(long current) {
        return returnTopology == topology && homeward[find(current)] != 0;
    }

    /** After planning, the next attested hop back toward the anchor, not a movement command. */
    long returnNext(long current) {
        if (returnTopology != topology) return NO_CELL;
        int node = find(current);
        int hop = homeward[node];
        return hop == 0 || hop == node ? NO_CELL : cells[hop];
    }

    private int proveReturn(int budget) {
        if (returnTopology == topology) return 0;
        Arrays.fill(homeward, 1, count + 1, (short) 0);
        homeward[anchor] = (short) anchor;
        int head = 0, tail = 1;
        queue[0] = (short) anchor;
        while (head < tail) {
            if (head == budget) return -1;
            short node = queue[head++];
            int start = node * SLOTS;
            for (int edge = start; edge < start + SLOTS; edge++) {
                short predecessor = incoming[edge];
                if (predecessor == 0 || homeward[predecessor] != 0) continue;
                homeward[predecessor] = node;
                queue[tail++] = predecessor;
            }
        }
        returnTopology = topology;
        return head;
    }

    private Status search(int here, int budget) {
        Arrays.fill(distance, 1, count + 1, (short) -1);
        distance[here] = 0;
        int head = 0, tail = 1, best = 0;
        queue[0] = (short) here;
        while (head < tail) {
            if (head == budget) return Status.LIMIT;
            int node = queue[head++];
            if (node == target) {
                // The old segment ended or was cut; keep its endpoint when still reachable.
                return commit(here, target, work);
            }
            if (better(node, best, here)) best = node;
            int start = node * SLOTS;
            for (int edge = start; edge < start + SLOTS; edge++) {
                short to = outgoing[edge];
                if (to == 0 || retired[edge] != null || homeward[to] == 0 || distance[to] >= 0) continue;
                distance[to] = (short) (distance[node] + 1);
                parent[to] = (short) node;
                queue[tail++] = to;
            }
        }
        if (best != 0) return commit(here, best, goals[best] > 0 ? Work.GOAL
            : openViews[best] != 0 ? Work.FRONTIER : Work.LOWER);
        clearTarget();
        closedAt = here;
        closedRevision = revision;
        return closedStatus = saturated ? Status.LIMIT : Status.NO_ROUTE;
    }

    private boolean better(int node, int best, int here) {
        if (goals[node] == 0 && openViews[node] == 0 && (reached[node] || y(cells[node]) >= y(cells[here]))) return false;
        if (best == 0) return true;
        if (goals[node] != goals[best]) return goals[node] > goals[best];
        int depth = y(cells[node]) - y(cells[best]);
        if (depth != 0) return depth < 0;
        boolean hasView = openViews[node] != 0;
        if (hasView != (openViews[best] != 0)) return hasView;
        if (goals[node] == 0 && hasView && reached[node] != reached[best]) return !reached[node];
        if (distance[node] != distance[best]) return distance[node] < distance[best];
        return cells[node] < cells[best];
    }

    private Status commit(int here, int end, Work purpose) {
        target = end;
        work = purpose;
        cursor = 0;
        length = Math.min(MAX_SEGMENT, distance[end]);
        selectedBearing = -1;
        if (here == end) return purpose == Work.GOAL ? Status.GOAL : selectView(here);
        int node = end;
        while (distance[node] > length) node = parent[node];
        for (int step = length - 1; step >= 0; step--) {
            segment[step] = (short) node;
            node = parent[node];
        }
        segmentTopology = topology;
        return Status.MOVE;
    }

    private Status selectView(int node) {
        if ((openViews[node] & viewBit(selectedBearing)) == 0)
            selectedBearing = Integer.numberOfTrailingZeros(openViews[node]);
        return Status.FRONTIER;
    }

    private boolean safeSuffix(int here) {
        int from = here;
        for (int step = cursor; step < length; step++) {
            int to = segment[step];
            if (homeward[to] == 0 || !usable(cells[from], cells[to])) return false;
            from = to;
        }
        return true;
    }

    private Status stop(Status reason) {
        clearTarget();
        return status = reason;
    }

    private void clearTarget() {
        target = cursor = length = 0;
        selectedBearing = -1;
        work = null;
    }

    private void open(int from, int slot, int to) {
        int edge = from * SLOTS + slot;
        outgoing[edge] = (short) to;
        incoming[to * SLOTS + opposite(slot)] = (short) from;
        retired[edge] = null;
        edges++;
        topology++;
        revision++;
    }

    private int edge(long from, long to) {
        int slot = slot(from, to);
        int a = find(from);
        if (slot < 0 || a == 0) return -1;
        int edge = a * SLOTS + slot;
        int b = outgoing[edge];
        return b != 0 && cells[b] == to ? edge : -1;
    }

    private boolean markReached(int node) {
        if (reached[node]) return false;
        reached[node] = true;
        revision++;
        return true;
    }

    private int find(long cell) {
        return cell == NO_CELL ? 0 : index[hashSlot(cell)];
    }

    private int addCell(long cell) {
        int bucket = hashSlot(cell);
        cells[++count] = cell;
        index[bucket] = (short) count;
        return count;
    }

    private int hashSlot(long cell) {
        long mixed = (cell ^ (cell >>> 27)) * 0x9e3779b97f4a7c15L;
        int mask = index.length - 1;
        int bucket = (int) (mixed >>> 56);
        for (int node; (node = index[bucket]) != 0 && cells[node] != cell;) bucket = (bucket + 1) & mask;
        return bucket;
    }

    private static int slot(long from, long to) {
        if (from == NO_CELL || to == NO_CELL) return -1;
        int dy = y(to) - y(from);
        if (dy < -1 || dy > 1) return -1;
        int dx = (int) (to >> 38) - (int) (from >> 38);
        int dz = (int) ((to << 26) >> 38) - (int) ((from << 26) >> 38);
        if (dz == 0 && (dx == 1 || dx == -1)) return (dx > 0 ? 0 : 3) + dy + 1;
        if (dx == 0 && (dz == 1 || dz == -1)) return (dz > 0 ? 6 : 9) + dy + 1;
        return -1;
    }

    private static int y(long cell) { return (int) (cell << 52 >> 52); }
    private static int opposite(int slot) { return ((slot / 3) ^ 1) * 3 + 2 - slot % 3; }
    private static int viewBit(int bearing) { return bearing >= 0 && bearing < SLOTS ? 1 << bearing : 0; }
}
