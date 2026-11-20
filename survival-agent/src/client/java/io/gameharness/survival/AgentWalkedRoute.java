package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.cell;
import static io.gameharness.survival.AgentRouteGraph.y;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.block.BlockState;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** Bounded memory of completed, reversible dry legs. A next cell is a clue, never an input grant. */
final class AgentWalkedRoute {
    // At most two new nodes per retained edge plus an isolated anchor; fits AgentRouteGraph.
    static final int LIVE_EDGES = 60;
    static final int SAVED_EDGES = 36;
    record Breadcrumbs(int[] footing, int[][] edges) {}

    /** Small motion witness used only inside a motor that already checked the exact lane. */
    static final class Motion {
        private double x, y, z;
        private int contacts;
        private boolean contiguous;

        void start(double x, double y, double z) {
            this.x = x;
            this.y = y;
            this.z = z;
            contacts = 0;
            contiguous = true;
        }

        boolean observe(double x, double y, double z) {
            double dx = x - this.x, dy = y - this.y, dz = z - this.z;
            double horizontal = dx * dx + dz * dz;
            this.x = x;
            this.y = y;
            this.z = z;
            if (horizontal + dy * dy > 0.31) contiguous = false;
            if (horizontal > 0.0004) contacts++;
            return contiguous;
        }

        boolean traversed() { return contiguous && contacts >= 3; }
    }

    /** Live receipts from separately owned walks only; restored breadcrumbs cannot fill this path. */
    static final class Recovery {
        private final ArrayList<AgentSurfaceTread.Edge> path = new ArrayList<>();
        private Object owner;
        private BlockPos next;
        private BlockState support;
        private Vec3d stance;
        private long revision;
        private boolean walked, invalid;

        void begin(Object action, BlockPos from, BlockState exactSupport, Vec3d feet) {
            if (owner == action) return;
            if (owner != null) clear();
            observe(from, exactSupport, feet);
            owner = action;
            next = from;
            support = exactSupport;
            walked = false;
            invalid = exactSupport == null;
        }

        void landed(AgentSurfaceTread.Edge leg) {
            if (owner == null || invalid) return;
            if (!leg.upper().equals(next) || leg.upperSupport() != support || leg.lowerSupport() == null
                    || !AgentSurfaceTread.cardinalTread(leg.upper(), leg.lower(), leg.down())) {
                invalid = true;
                return;
            }
            if (path.size() == LIVE_EDGES) path.removeFirst();
            path.add(leg);
            next = leg.lower();
            support = leg.lowerSupport();
            walked = true;
        }

        void finish(Object action, boolean success, BlockPos foot, BlockState exactSupport, Vec3d feet) {
            if (owner != action) return;
            owner = null;
            if (!success || invalid || !foot.equals(next) || exactSupport != support) clear();
            else if (walked) {
                stance = feet;
                ++revision;
            } else observe(foot, exactSupport, feet);
        }

        void observe(BlockPos foot, BlockState exactSupport, Vec3d feet) {
            if (owner == null && stance != null && (exactSupport == null || exactSupport != path.getLast().lowerSupport()
                    || !foot.equals(path.getLast().lower()) || feet.squaredDistanceTo(stance) > 0.0144)) clear();
        }

        long proof() { return owner == null && stance != null ? revision : 0; }

        List<AgentSurfaceTread.Edge> path(long proof, BlockPos foot, BlockState exactSupport, Vec3d feet) {
            observe(foot, exactSupport, feet);
            return proof != 0 && proof == proof() ? path : List.of();
        }

        boolean observing() { return owner == null && stance != null; }

        void clear() {
            path.clear();
            owner = next = null;
            support = null;
            stance = null;
        }
    }

    private final AgentRouteGraph graph = new AgentRouteGraph();
    private final Recovery recovery = new Recovery();
    private final long[] starts = new long[LIVE_EDGES];
    private final long[] ends = new long[LIVE_EDGES];
    private int count, oldest;
    private long anchor = NO_CELL;
    private boolean rebuild = true;

    void clear() {
        count = oldest = 0;
        anchor = NO_CELL;
        rebuild = true;
        recovery.clear();
    }

    Recovery recovery() { return recovery; }

    boolean recoveringWalk() { return recovery.owner != null; }

    void landed(BlockPos from, BlockState source, BlockPos to, BlockState landing, Direction travel) {
        landed(from.asLong(), to.asLong());
        if (recovery.owner != null) recovery.landed(new AgentSurfaceTread.Edge(from, source, to, landing, travel));
    }

    long anchor() { return anchor; }

    void anchor(long footing) {
        if (anchor != footing) {
            anchor = footing;
            rebuild = true;
        }
    }

    /** Call only after the movement owner confirmed real settlement and reversible footing. */
    void landed(long from, long to) {
        if (!AgentRouteGraph.cardinalStep(from, to)) return;
        if (find(from, to) >= 0) return;
        int slot = count;
        for (int i = 0; i < count; i++) {
            if (starts[i] == NO_CELL) { slot = i; break; }
        }
        if (slot == LIVE_EDGES) {
            // Give the observed anchor its own lifetime; evict other history before its incident legs.
            slot = oldest;
            for (int i = 0; i < count && touchesAnchor(slot); i++) slot = (slot + 1) % count;
            oldest = (slot + 1) % count;
            rebuild = true;
        } else if (slot == count) count++;
        starts[slot] = from;
        ends[slot] = to;
        if (!rebuild) link(from, to);
    }

    /** The selected lane was physically unsafe. A later completed traversal may renew it. */
    void rejected(long from, long to) {
        int slot = find(from, to);
        if (slot < 0) return;
        starts[slot] = ends[slot] = NO_CELL;
        rebuild = true;
    }

    boolean connected(long footing) {
        refresh();
        return graph.refreshReturn(footing);
    }

    long next(long footing) {
        return connected(footing) ? graph.returnNext(footing) : NO_CELL;
    }

    Breadcrumbs breadcrumbs(long from) {
        if (from == anchor || !connected(from)) return null;
        int size = 0;
        for (long at = from; at != anchor; at = graph.returnNext(at))
            if (++size > SAVED_EDGES) return null;
        int[][] edges = new int[size][];
        for (int i = 0; i < size; i++) {
            long to = graph.returnNext(from);
            edges[i] = new int[] {x(from), y(from), z(from), x(to), y(to), z(to)};
            from = to;
        }
        return new Breadcrumbs(new int[] {x(anchor), y(anchor), z(anchor)}, edges);
    }

    void restore(Breadcrumbs route) {
        int[][] edges = route.edges;
        for (int i = edges.length - 1; i >= 0; i--) {
            int[] edge = edges[i];
            landed(cell(edge[0], edge[1], edge[2]), cell(edge[3], edge[4], edge[5]));
        }
        int[] foot = route.footing;
        anchor(cell(foot[0], foot[1], foot[2]));
    }

    static boolean validBreadcrumbs(Breadcrumbs route, int sx, int sy, int sz) {
        if (route == null) return true;
        int[] foot = route.footing;
        int[][] edges = route.edges;
        if (foot == null || foot.length != 3 || !validCoordinates(foot, 0)
                || Math.abs(foot[0] - sx) > 6 || Math.abs(foot[1] - sy) > 6 || Math.abs(foot[2] - sz) > 6
                || edges == null || edges.length == 0 || edges.length > SAVED_EDGES) return false;
        for (int i = 0; i < edges.length; i++) {
            int[] edge = edges[i];
            if (edge == null || edge.length != 6 || !validCoordinates(edge, 0) || !validCoordinates(edge, 3)
                    || !AgentRouteGraph.cardinalStep(cell(edge[0], edge[1], edge[2]), cell(edge[3], edge[4], edge[5]))
                    || i > 0 && !same(edges[i - 1], 3, edge, 0)) return false;
            for (int j = 0; j <= i; j++) if (same(edges[j], 0, edge, 3)) return false;
        }
        return same(edges[edges.length - 1], 3, foot, 0);
    }

    private static boolean validCoordinates(int[] c, int i) {
        return c[i] >= -30_000_000 && c[i] <= 30_000_000 && c[i + 1] >= -64 && c[i + 1] <= 320
            && c[i + 2] >= -30_000_000 && c[i + 2] <= 30_000_000;
    }

    private static boolean same(int[] a, int i, int[] b, int j) {
        return a[i] == b[j] && a[i + 1] == b[j + 1] && a[i + 2] == b[j + 2];
    }

    private int find(long from, long to) {
        for (int i = 0; i < count; i++) {
            if (starts[i] == from && ends[i] == to || starts[i] == to && ends[i] == from) return i;
        }
        return -1;
    }

    private boolean touchesAnchor(int slot) { return starts[slot] == anchor || ends[slot] == anchor; }

    private void refresh() {
        if (!rebuild) return;
        graph.reset(anchor);
        rebuild = false;
        if (anchor == NO_CELL) return;
        for (int i = 0; i < count; i++) if (starts[i] != NO_CELL) link(starts[i], ends[i]);
    }

    private void link(long from, long to) {
        graph.walked(from, to);
        graph.observe(to, from);
    }

    private static int x(long cell) { return (int) (cell >> 38); }
    private static int z(long cell) { return (int) (cell << 26 >> 38); }
}
