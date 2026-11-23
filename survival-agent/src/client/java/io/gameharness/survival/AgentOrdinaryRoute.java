package io.gameharness.survival;

import static io.gameharness.survival.AgentRouteGraph.NO_CELL;
import static io.gameharness.survival.AgentRouteGraph.neighbor;
import static io.gameharness.survival.AgentRouteGraph.x;
import static io.gameharness.survival.AgentRouteGraph.y;
import static io.gameharness.survival.AgentRouteGraph.z;

import java.util.Arrays;

/** Directed, rolling dry-foot memory. Only its adapter can see, settle on, or drive an edge. */
final class AgentOrdinaryRoute {
    private static final int NODES = 192, SLOTS = 12, SIGHT_TICKS = 100;
    private static final int UNCUED_FOOD_DROP = 2;
    private final long[] feet = new long[NODES + 1];
    private final short[] index = new short[512];
    private final short[] edges = new short[(NODES + 1) * SLOTS];
    private final int[] seen = new int[edges.length];
    private final int[] retryAfter = new int[edges.length];
    private final int[] touched = new int[NODES + 1];
    private final boolean[] grounded = new boolean[NODES + 1];
    private final int[] visited = new int[NODES + 1];
    private final int[] looked = new int[NODES + 1];
    private final int[] forageSeen = new int[NODES + 1];
    private final boolean[] foodVisited = new boolean[NODES + 1], foodLooked = new boolean[NODES + 1];
    private final short[] queue = new short[NODES], parent = new short[NODES + 1], depth = new short[NODES + 1];
    private final long[] suffix = new long[NODES];
    private final boolean[] connected = new boolean[NODES + 1];
    private int connectedTick = -1, connectedRevision;
    private long connectedFrom = NO_CELL;

    private int nodes, intent = 1, plans, revision, examinedRevision, examinedTick, examinedRetry;
    private int cursor, length;
    private long origin = NO_CELL, endpoint = NO_CELL;
    private long forageFoot = NO_CELL;
    private int firstFoodY = Integer.MIN_VALUE;
    private boolean directed, exact, foodSearch, returningForFood;
    private double goalX, goalZ, radiusSquared, minY, maxY, axisX, axisZ;

    void clear() {
        Arrays.fill(index, (short) 0);
        Arrays.fill(edges, (short) 0);
        Arrays.fill(seen, 0);
        Arrays.fill(retryAfter, 0);
        Arrays.fill(grounded, false);
        Arrays.fill(visited, 0);
        Arrays.fill(looked, 0);
        Arrays.fill(forageSeen, 0);
        nodes = plans = revision = 0;
        connectedFrom = NO_CELL;
        intent = 1;
        forageFoot = NO_CELL;
        foodSearch = false;
        resetFoodSearch();
        renew();
    }

    void destination(double x, double z, double arrival, double minFootY, double maxFootY) {
        renew();
        directed = true;
        foodSearch = false;
        goalX = x;
        goalZ = z;
        radiusSquared = arrival * arrival;
        minY = minFootY;
        maxY = maxFootY;
    }

    void explore(double dx, double dz) {
        renew();
        directed = false;
        foodSearch = false;
        axisX = dx;
        axisZ = dz;
    }

    void exploreFood(double dx, double dz) {
        explore(dx, dz);
        foodSearch = true;
    }

    void resetFoodSearch() {
        Arrays.fill(foodVisited, false);
        Arrays.fill(foodLooked, false);
        firstFoodY = Integer.MIN_VALUE;
        returningForFood = false;
        if (foodSearch) clearSuffix();
    }

    /** Record an occupied resource habitat, not merely a sighting of one across a gap. */
    void rememberForagingFoot(long foot, int tick) {
        contact(foot, tick);
        if (forageFoot == foot) return;
        if (returningForFood) clearSuffix();
        if (forageFoot == NO_CELL || y(forageFoot) != y(foot)) revision++;
        forageFoot = foot;
        returningForFood = false;
    }

    boolean atForagingFoot(long foot) { return foot == forageFoot; }

    boolean returningForFood() { return foodSearch && returningForFood; }

    private int foodFloor() { return (forageFoot == NO_CELL ? firstFoodY : y(forageFoot)) - UNCUED_FOOD_DROP; }

    void witnessForagingTop(long foot, int tick) {
        int n = find(foot);
        if (n == 0) return;
        if (!freshForagingTop(n, tick)) revision++;
        forageSeen[n] = tick;
    }

    private boolean freshForagingTop(int n, int tick) {
        return forageSeen[n] != 0 && tick - forageSeen[n] <= SIGHT_TICKS;
    }

    private boolean outsideScoutBand(int n, int tick, int floor) {
        return floor != Integer.MIN_VALUE && y(feet[n]) < floor && !freshForagingTop(n, tick);
    }

    private void renew() {
        intent++;
        origin = NO_CELL;
        clearSuffix();
    }

    void contact(long foot, int tick) {
        grounded[node(foot, tick, NO_CELL)] = true;
    }

    boolean walked(long foot) { return grounded[find(foot)]; }

    /** Admission for an optional detour. Do not replace the current search with a proxy for a proxy. */
    boolean hasPath(long from, long to, int tick) {
        int start = find(from), end = find(to);
        if (start == 0 || end == 0) return false;
        if (connectedFrom != from || connectedTick != tick || connectedRevision != revision) {
            Arrays.fill(connected, 1, nodes + 1, false);
            connectedFrom = from;
            connectedTick = tick;
            connectedRevision = revision;
            connected[start] = true;
            queue[0] = (short) start;
            int tail = 1;
            for (int head = 0; head < tail; head++) {
                int first = queue[head] * SLOTS;
                for (int edge = first; edge < first + SLOTS; edge++) {
                    short next = edges[edge];
                    if (next == 0 || connected[next] || !usable(edge, tick)) continue;
                    connected[next] = true;
                    queue[tail++] = next;
                }
            }
        }
        return connected[end];
    }

    void observe(long from, long to, int tick) { attest(from, to, tick, false); }

    /** The reverse of a real crossing is a route candidate, not a second landing. */
    void rememberReturn(long from, long to, int tick) { attest(from, to, tick, true); }

    /** Records physical contact and optionally consumes the current route's next exact edge. */
    void landed(long from, long to, int tick) {
        attest(from, to, tick, true);
        if (origin == from && hop(0) == to) {
            // Exploration has no fixed B. After a real detour, look ahead from
            // the completed crossing instead of steering back to the spawn yaw.
            if (!directed) {
                axisX = x(to) - x(from);
                axisZ = z(to) - z(from);
            }
            origin = to;
            markVisited(find(to));
            cursor++;
            examinedRevision = -1;
        }
    }

    private void attest(long from, long to, int tick, boolean walked) {
        int slot = AgentRouteGraph.slot(from, to);
        if (slot < 0) return;
        int a = node(from, tick, to), b = node(to, tick, from);
        int edge = a * SLOTS + slot;
        if (!walked && retryAfter[edge] > tick) return;
        if (edges[edge] != b || seen[edge] != Integer.MAX_VALUE && (walked || !usable(edge, tick))
                || walked && retryAfter[edge] > tick) revision++;
        edges[edge] = (short) b;
        if (walked) {
            seen[edge] = Integer.MAX_VALUE;
            grounded[a] = grounded[b] = true;
        } else if (seen[edge] != Integer.MAX_VALUE) seen[edge] = tick;
        retryAfter[edge] = 0;
    }

    void retire(long from, long to, int retry) {
        int node = find(from), slot = AgentRouteGraph.slot(from, to);
        if (node == 0 || slot < 0) return;
        int edge = node * SLOTS + slot;
        if (edges[edge] == 0 || feet[edges[edge]] != to) return;
        retryAfter[edge] = retry;
        // A valid old traversal records contact, not continuing clearance after a veto.
        seen[edge] = 0;
        revision++;
    }

    /** A motor timeout without a geometry veto can pause, but not erase, a walked tread. */
    boolean deferWalked(long from, long to, int retry) {
        int node = find(from), slot = AgentRouteGraph.slot(from, to);
        if (node == 0 || slot < 0) return false;
        int edge = node * SLOTS + slot;
        if (seen[edge] != Integer.MAX_VALUE || edges[edge] == 0 || feet[edges[edge]] != to) return false;
        retryAfter[edge] = retry;
        revision++;
        return true;
    }

    boolean canLook(long foot) {
        int node = find(foot);
        return node != 0 && !looked(node);
    }

    void consumeLook(long foot) {
        int node = find(foot);
        if (node != 0 && !looked(node)) {
            if (foodSearch) foodLooked[node] = true;
            else looked[node] = intent;
            revision++;
        }
    }

    private boolean looked(int node) { return foodSearch ? foodLooked[node] : looked[node] == intent; }

    private void markVisited(int node) {
        if (foodSearch) foodVisited[node] = true;
        else visited[node] = intent;
    }

    long endpoint() { return endpoint; }
    boolean exact() { return exact; }
    int remaining() { return length - cursor; }
    int plans() { return plans; }
    long hop(int offset) {
        return offset >= 0 && offset < remaining() ? suffix[cursor + offset] : NO_CELL;
    }

    boolean fits(long foot) {
        if (!directed || y(foot) < minY || y(foot) > maxY) return false;
        double dx = x(foot) + 0.5 - goalX, dz = z(foot) + 0.5 - goalZ;
        return dx * dx + dz * dz <= radiusSquared;
    }

    void plan(long current, int tick) {
        int start = find(current);
        if (start == 0) return;
        if (foodSearch) {
            if (firstFoodY == Integer.MIN_VALUE) firstFoodY = y(current);
            // A targeted pickup, a fall, or a restored stance can be below the
            // scouting band. Return along an actual connected route, not a proxy.
            boolean recover = forageFoot != NO_CELL && current != forageFoot
                && (returningForFood || y(current) < foodFloor());
            if (recover != returningForFood) {
                returningForFood = recover;
                clearSuffix();
            }
        }
        if (origin != current) {
            clearSuffix();
            origin = current;
        }
        markVisited(start);
        boolean returning = returningForFood();
        int scoutFloor = foodSearch && !returning ? foodFloor() : Integer.MIN_VALUE;
        boolean keep = remaining() > 0 && suffixUsable(current, tick, scoutFloor);
        if (keep && (exact || !directed || examinedRevision == revision)) return;
        if (exact && endpoint == current) return;
        if (!keep && remaining() > 0) examinedRevision = -1;
        if (examinedRevision == revision && endpoint == NO_CELL
                && tick < examinedRetry && tick - examinedTick < SIGHT_TICKS) return;
        examinedRevision = revision;
        examinedTick = tick;
        examinedRetry = Integer.MAX_VALUE;

        // A breadth-first walk over positively attested edges. No destination heuristic
        // prunes sideways or away legs, and disconnected witnesses cannot become a route.
        Arrays.fill(depth, 1, nodes + 1, (short) -1);
        depth[start] = 0;
        queue[0] = (short) start;
        int tail = 1, frontier = 0, goal = 0, viewpoint = 0;
        double best = Double.POSITIVE_INFINITY;
        double viewpointCost = Double.POSITIVE_INFINITY;
        for (int head = 0; head < tail; head++) {
            int at = queue[head];
            long foot = feet[at];
            if (returning ? foot == forageFoot : fits(foot)) {
                goal = at;
                break;
            }
            if (!returning && !(foodSearch ? foodVisited[at] : visited[at] == intent)) {
                double dx = x(foot) - x(current), dz = z(foot) - z(current);
                double score = directed
                    ? Math.hypot(x(foot) + 0.5 - goalX, z(foot) + 0.5 - goalZ)
                        + 1.3 * Math.max(0, Math.max(minY - y(foot), y(foot) - maxY)) + depth[at] * 0.20
                    : -dx * axisX - dz * axisZ - 0.55 * Math.hypot(dx, dz) + depth[at] * 0.28;
                if (foodSearch && !freshForagingTop(at, tick)) score += 1.75 * Math.max(0, y(current) - y(foot));
                if (foot == endpoint || (frontier == 0 || feet[frontier] != endpoint) && score < best) {
                    frontier = at;
                    best = score;
                }
            } else if (!directed && !returning && looked(start) && grounded[at] && !looked(at)
                    && (!foodSearch || y(foot) >= y(current) || freshForagingTop(at, tick))) {
                // All nearby treads may already be walked. A dry junction we
                // crossed without looking can expose new ground from a different
                // angle. Do not turn around for another view one block away.
                int dx = x(foot) - x(current), dz = z(foot) - z(current);
                double cost = depth[at] + 2 * Math.max(0, y(foot) - y(current));
                if (dx * dx + dz * dz >= 4 && cost < viewpointCost) {
                    viewpoint = at;
                    viewpointCost = cost;
                }
            }
            int first = at * SLOTS;
            for (int edge = first; edge < first + SLOTS; edge++) {
                short next = edges[edge];
                if (next == 0 || depth[next] >= 0 || outsideScoutBand(next, tick, scoutFloor)) continue;
                if (!usable(edge, tick)) {
                    if (seen[edge] == Integer.MAX_VALUE) examinedRetry = Math.min(examinedRetry, retryAfter[edge]);
                    continue;
                }
                depth[next] = (short) (depth[at] + 1);
                parent[next] = (short) at;
                queue[tail++] = next;
            }
        }
        if (goal == 0 && keep) return; // A new view must not churn an outstanding proxy.
        int end = goal != 0 ? goal : frontier != 0 ? frontier : viewpoint;
        if (end == 0) {
            clearSuffix();
            examinedRevision = revision;
            return;
        }
        endpoint = feet[end];
        exact = end == goal;
        cursor = 0;
        length = depth[end];
        for (int step = length - 1; step >= 0; step--) {
            suffix[step] = feet[end];
            end = parent[end];
        }
        plans++;
    }

    private boolean suffixUsable(long from, int tick, int scoutFloor) {
        for (int i = cursor; i < length; i++) {
            long to = suffix[i];
            int n = find(from), slot = AgentRouteGraph.slot(from, to);
            int edge = n * SLOTS + slot;
            if (n == 0 || slot < 0 || edges[edge] == 0 || feet[edges[edge]] != to || !usable(edge, tick)
                    || outsideScoutBand(edges[edge], tick, scoutFloor))
                return false;
            from = to;
        }
        return true;
    }

    private boolean usable(int edge, int tick) {
        return retryAfter[edge] <= tick && seen[edge] != 0
            && (seen[edge] == Integer.MAX_VALUE || tick - seen[edge] <= SIGHT_TICKS);
    }

    private void clearSuffix() {
        cursor = length = 0;
        endpoint = NO_CELL;
        exact = false;
        examinedRevision = -1;
    }

    private int find(long cell) {
        return cell == NO_CELL ? 0 : index[bucket(cell)];
    }

    private int bucket(long foot) {
        int mask = index.length - 1;
        int at = (int) ((foot ^ foot >>> 27) * 0x9e3779b97f4a7c15L >>> 55);
        for (int n; (n = index[at]) != 0 && feet[n] != foot;) at = (at + 1) & mask;
        return at;
    }

    private int node(long foot, int tick, long protect) {
        int n = find(foot);
        if (n == 0) {
            n = nodes < NODES ? ++nodes : evict(foot, protect, tick);
            feet[n] = foot;
            index[bucket(foot)] = (short) n;
        }
        touched[n] = tick;
        return n;
    }

    private int evict(long near, long protect, int tick) {
        int victim = 0, highest = Integer.MIN_VALUE;
        for (int n = 1; n <= nodes; n++) {
            long foot = feet[n];
            if (foot == protect || foot == origin) continue;
            int score = Math.abs(x(foot) - x(near)) + Math.abs(z(foot) - z(near)) + Math.abs(y(foot) - y(near))
                + Math.min(100, Math.max(0, tick - touched[n])) / 6 - (grounded[n] ? 8 : 0);
            if (score > highest) {
                victim = n;
                highest = score;
            }
        }
        int mask = index.length - 1, hole = bucket(feet[victim]);
        index[hole] = 0;
        // Restore the probe chain after deleting a bucket.
        for (int at = (hole + 1) & mask; index[at] != 0; at = (at + 1) & mask) {
            short move = index[at];
            index[at] = 0;
            index[bucket(feet[move])] = move;
        }
        long leaving = feet[victim];
        for (int slot = 0; slot < SLOTS; slot++) {
            int bearing = slot / 3;
            int other = find(neighbor(leaving, bearing, slot % 3 - 1));
            int reverse = other * SLOTS + (bearing ^ 1) * 3 + 2 - slot % 3;
            if (other != 0 && edges[reverse] == victim) clearEdge(reverse);
            clearEdge(victim * SLOTS + slot);
        }
        grounded[victim] = false;
        visited[victim] = looked[victim] = forageSeen[victim] = 0;
        foodVisited[victim] = foodLooked[victim] = false;
        revision++;
        return victim;
    }

    private void clearEdge(int edge) {
        edges[edge] = 0;
        seen[edge] = retryAfter[edge] = 0;
    }
}
