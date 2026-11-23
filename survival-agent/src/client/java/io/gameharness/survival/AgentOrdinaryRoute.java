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
    private static final int UNCUED_FOOD_DROP = 2, EGRESS_SCOUT_DROP = 1;
    private static final int TIMBER_TILE_SHIFT = 3, TIMBER_TILE_BITS = 6, TIMBER_TILE_LIMIT = 10;
    private static final int TIMBER_TILES = 1 << TIMBER_TILE_BITS;
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
    private final boolean[] foodOutletTried = new boolean[NODES + 1];
    private final boolean[] timberVisited = new boolean[NODES + 1], timberLooked = new boolean[NODES + 1];
    private final long[] timberTiles = new long[TIMBER_TILES];
    private final byte[] timberCoverage = new byte[TIMBER_TILES];
    private final short[] queue = new short[NODES], parent = new short[NODES + 1], depth = new short[NODES + 1];
    private final short[] routeLow = new short[NODES + 1];
    private final long[] suffix = new long[NODES];
    private final boolean[] connected = new boolean[NODES + 1];
    private int connectedTick = -1, connectedRevision;
    private long connectedFrom = NO_CELL;

    private int nodes, intent = 1, plans, revision, examinedRevision, examinedTick, examinedRetry;
    private int cursor, length;
    private long origin = NO_CELL, endpoint = NO_CELL;
    private long forageFoot = NO_CELL, egressShoulder = NO_CELL;
    private long foodCutAt = NO_CELL;
    private boolean foodCutReopened;
    private long timberCue = NO_CELL;
    private int timberCueTick;
    private int firstFoodY = Integer.MIN_VALUE, egressHighY = Integer.MIN_VALUE;
    private boolean directed, exact, foodSearch, returningForFood, viaFoodConnector, timberSearch, timberCourse;
    private double goalX, goalZ, radiusSquared, minY, maxY, axisX, axisZ;
    private double timberX, timberZ;

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
        timberSearch = timberCourse = false;
        timberCue = NO_CELL;
        Arrays.fill(timberVisited, false);
        Arrays.fill(timberLooked, false);
        Arrays.fill(timberCoverage, (byte) 0);
        resetFoodSearch();
        renew();
    }

    void destination(double x, double z, double arrival, double minFootY, double maxFootY) {
        renew();
        directed = true;
        foodSearch = timberSearch = false;
        goalX = x;
        goalZ = z;
        radiusSquared = arrival * arrival;
        minY = minFootY;
        maxY = maxFootY;
    }

    void explore(double dx, double dz) {
        renew();
        directed = false;
        foodSearch = timberSearch = false;
        axisX = dx;
        axisZ = dz;
    }

    void exploreFood(double dx, double dz) {
        explore(dx, dz);
        foodSearch = true;
    }

    void exploreTimber(double dx, double dz) {
        if (!timberCourse) {
            timberX = dx;
            timberZ = dz;
            timberCourse = true;
        }
        explore(timberX, timberZ);
        timberSearch = true;
    }

    /** A first hit can steer the search; it cannot certify a foothold or a timber destination. */
    void witnessTimberHorizon(long from, long cue, int tick) {
        if (!timberSearch || !freshTimberArea(cue)) return;
        if (timberCueLive(from, tick)) {
            if (timberCue == cue) timberCueTick = tick;
            return;
        }
        timberCue = cue;
        timberCueTick = tick;
        clearSuffix();
    }

    float timberLookYaw(long foot, int tick) {
        boolean green = timberCueLive(foot, tick);
        return (float) Math.toDegrees(Math.atan2(green ? x(foot) - x(timberCue) : -timberX,
            green ? z(timberCue) - z(foot) : timberZ));
    }

    private boolean timberCueLive(long foot, int tick) {
        if (timberCue == NO_CELL || tick - timberCueTick > SIGHT_TICKS || !freshTimberArea(timberCue)) return false;
        int dx = x(timberCue) - x(foot), dz = z(timberCue) - z(foot);
        return dx * dx + dz * dz > 4;
    }

    boolean freshTimberArea(long foot) { return timberCoverage(foot) < TIMBER_TILE_LIMIT / 2; }

    private static long timberTile(long foot) {
        return AgentRouteGraph.cell(x(foot) >> TIMBER_TILE_SHIFT, 0, z(foot) >> TIMBER_TILE_SHIFT);
    }

    private static int timberTileSlot(long tile) {
        return (int) ((tile ^ tile >>> 27) * 0x9e3779b97f4a7c15L >>> (Long.SIZE - TIMBER_TILE_BITS));
    }

    private int timberCoverage(long foot) {
        long tile = timberTile(foot);
        int slot = timberTileSlot(tile);
        return timberTiles[slot] == tile ? timberCoverage[slot] : 0;
    }

    private void occupyTimberFoot(int node) {
        if (timberVisited[node]) return;
        timberVisited[node] = true;
        long tile = timberTile(feet[node]);
        int slot = timberTileSlot(tile);
        if (timberTiles[slot] != tile) {
            timberTiles[slot] = tile;
            timberCoverage[slot] = 0;
        }
        if (timberCoverage[slot] < TIMBER_TILE_LIMIT) timberCoverage[slot]++;
    }

    void resetFoodSearch() {
        Arrays.fill(foodVisited, false);
        Arrays.fill(foodLooked, false);
        Arrays.fill(foodOutletTried, false);
        foodCutAt = NO_CELL;
        foodCutReopened = false;
        firstFoodY = Integer.MIN_VALUE;
        clearFoodEgress();
        returningForFood = false;
        if (foodSearch) clearSuffix();
    }

    void clearFoodEgress() {
        if (egressHighY == Integer.MIN_VALUE) return;
        egressHighY = Integer.MIN_VALUE;
        egressShoulder = NO_CELL;
        if (foodSearch) clearSuffix();
    }

    /** Called only for a completed supply crossing, not a target or a visible lip. */
    boolean foodEgressLanded(long from, long to, int tick) {
        int source = node(from, tick, to), landing = node(to, tick, from);
        grounded[source] = grounded[landing] = true;
        foodVisited[source] = foodVisited[landing] = true;
        if (foodSearch) clearSuffix();
        if (y(to) <= y(from) || y(to) <= egressHighY) return false;
        egressHighY = y(to);
        egressShoulder = from;
        // Pay for at most one look back into the junction after a genuinely
        // higher landing; the prior look may predate the opened passage.
        foodLooked[source] = false;
        return true;
    }

    /** Record an occupied resource habitat, not merely a sighting of one across a gap. */
    void rememberForagingFoot(long foot, int tick) {
        contact(foot, tick);
        clearFoodEgress();
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
            // Generic scouting follows its last edge; timber retains a coarse
            // course so a necessary dogleg cannot turn it back into a dry pocket.
            if (!directed && !timberSearch) {
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

    boolean lookSpent(long foot) {
        int node = find(foot);
        return node != 0 && looked(node);
    }

    void consumeLook(long foot) {
        int node = find(foot);
        if (node != 0 && !looked(node)) {
            if (foodSearch) foodLooked[node] = true;
            else if (timberSearch) timberLooked[node] = true;
            else looked[node] = intent;
            revision++;
        }
    }

    boolean beginFoodOutlet(long foot) {
        int n = find(foot);
        if (!foodSearch || n == 0 || !grounded[n] || !foodLooked[n] || foodOutletTried[n] || hop(0) != NO_CELL)
            return false;
        foodOutletTried[n] = true;
        revision++;
        return true;
    }

    boolean armFoodOutletCut(long foot) {
        int n = find(foot);
        if (!foodSearch || n == 0 || !foodOutletTried[n] || !foodLooked[n] || hop(0) != NO_CELL
                || foodCutAt != NO_CELL) return false;
        foodCutAt = foot;
        return true;
    }

    /** A verified edit can buy one fresh view, not an edge, an occupied tread, or food evidence. */
    boolean foodOutletOpened(long foot) {
        int n = find(foot);
        if (!foodSearch || n == 0 || foodCutAt != foot || foodCutReopened || !foodLooked[n]) return false;
        foodCutReopened = true;
        foodLooked[n] = false;
        revision++;
        return true;
    }

    private boolean looked(int node) {
        return timberSearch ? timberLooked[node] : foodSearch ? foodLooked[node] : looked[node] == intent;
    }

    private boolean visited(int node) {
        return timberSearch ? timberVisited[node] : foodSearch ? foodVisited[node] : visited[node] == intent;
    }

    private void markVisited(int node) {
        if (foodSearch) foodVisited[node] = true;
        else if (timberSearch) occupyTimberFoot(node);
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
        boolean keepingEgress = foodSearch && !returning && egressHighY != Integer.MIN_VALUE;
        if (keepingEgress) scoutFloor = Math.max(scoutFloor, Math.min(egressHighY - EGRESS_SCOUT_DROP, y(current)));
        boolean keep = remaining() > 0 && suffixUsable(current, tick, scoutFloor);
        if (keep && (exact || !directed || examinedRevision == revision)) return;
        if (exact && endpoint == current) return;
        if (!keep && remaining() > 0) examinedRevision = -1;
        if (examinedRevision == revision && endpoint == NO_CELL
                && tick < examinedRetry && tick - examinedTick < SIGHT_TICKS) return;
        examinedRevision = revision;
        examinedTick = tick;
        examinedRetry = Integer.MAX_VALUE;

        int end = findEndpoint(current, start, tick, scoutFloor, returning, keepingEgress, false);
        boolean connector = end == 0 && keepingEgress && looked(start);
        if (connector) end = findEndpoint(current, start, tick, scoutFloor, false, true, true);
        boolean reachedGoal = end != 0 && (returning ? feet[end] == forageFoot : fits(feet[end]));
        if (keep && !reachedGoal) return; // A new view must not churn an outstanding proxy.
        if (end == 0) {
            clearSuffix();
            examinedRevision = revision;
            return;
        }
        endpoint = feet[end];
        exact = reachedGoal;
        viaFoodConnector = connector;
        cursor = 0;
        length = depth[end];
        for (int step = length - 1; step >= 0; step--) {
            suffix[step] = feet[end];
            end = parent[end];
        }
        plans++;
    }

    private int findEndpoint(long current, int start, int tick, int scoutFloor, boolean returning,
                             boolean keepingEgress, boolean connector) {
        // A breadth-first walk over positively attested edges. No destination heuristic
        // prunes sideways or away legs, and disconnected witnesses cannot become a route.
        Arrays.fill(depth, 1, nodes + 1, (short) -1);
        depth[start] = 0;
        if (timberSearch) routeLow[start] = (short) y(current);
        double timberBiasX = timberX * 1.15, timberBiasZ = timberZ * 1.15;
        if (timberSearch && timberCueLive(current, tick)) {
            int dx = x(timberCue) - x(current), dz = z(timberCue) - z(current);
            double weight = 3 / Math.sqrt(dx * dx + dz * dz);
            timberBiasX = dx * weight;
            timberBiasZ = dz * weight;
        }
        queue[0] = (short) start;
        int tail = 1, frontier = 0, viewpoint = 0;
        boolean localOutlet = foodSearch && foodOutletTried[start];
        double best = Double.POSITIVE_INFINITY;
        double viewpointCost = Double.POSITIVE_INFINITY;
        for (int head = 0; head < tail; head++) {
            int at = queue[head];
            long foot = feet[at];
            if (returning ? foot == forageFoot : fits(foot)) return at;
            if (!returning && !visited(at)
                    && (!connector || y(foot) >= egressHighY || freshForagingTop(at, tick))) {
                double dx = x(foot) - x(current), dz = z(foot) - z(current);
                double score = directed
                    ? Math.hypot(x(foot) + 0.5 - goalX, z(foot) + 0.5 - goalZ)
                        + 1.3 * Math.max(0, Math.max(minY - y(foot), y(foot) - maxY)) + depth[at] * 0.20
                    : timberSearch ? timberFrontierCost(at, current, dx, dz, timberBiasX, timberBiasZ)
                        : -dx * axisX - dz * axisZ - 0.55 * Math.hypot(dx, dz) + depth[at] * 0.28;
                if (foodSearch && !freshForagingTop(at, tick)) score += 1.75 * Math.max(0, y(current) - y(foot));
                if (foot == endpoint || (frontier == 0 || feet[frontier] != endpoint) && score < best) {
                    frontier = at;
                    best = score;
                }
            } else if (!directed && !returning && !connector && grounded[at] && !looked(at)
                    && (looked(start) || timberSearch && y(foot) > y(current))
                    && (keepingEgress ? foot == egressShoulder
                        : !foodSearch || y(foot) >= y(current) - (localOutlet ? 1 : 0) || freshForagingTop(at, tick))) {
                // Ordinary scouting requires a distinct viewpoint. After a
                // failed climb, only the last high shoulder earns that revisit.
                int dx = x(foot) - x(current), dz = z(foot) - z(current);
                double cost = timberSearch ? timberFrontierCost(at, current, dx, dz, timberBiasX, timberBiasZ)
                    : depth[at] + 2 * Math.max(0, y(foot) - y(current));
                if ((keepingEgress ? at != start : dx * dx + dz * dz >= (localOutlet ? 1 : 4)) && cost < viewpointCost) {
                    viewpoint = at;
                    viewpointCost = cost;
                }
            }
            int first = at * SLOTS;
            for (int edge = first; edge < first + SLOTS; edge++) {
                short next = edges[edge];
                if (next == 0 || depth[next] >= 0 || !foodBandAllows(edge, next, tick, scoutFloor, connector))
                    continue;
                if (!usable(edge, tick)) {
                    if (seen[edge] == Integer.MAX_VALUE) examinedRetry = Math.min(examinedRetry, retryAfter[edge]);
                    continue;
                }
                depth[next] = (short) (depth[at] + 1);
                if (timberSearch) routeLow[next] = (short) Math.min(routeLow[at], y(feet[next]));
                parent[next] = (short) at;
                queue[tail++] = next;
            }
        }
        if (timberSearch && viewpoint != 0 && frontier != 0
                && y(feet[viewpoint]) > y(current) && y(feet[frontier]) < y(current) && viewpointCost + 1 < best)
            return viewpoint;
        return frontier != 0 ? frontier : viewpoint;
    }

    private double timberFrontierCost(int at, long current, double dx, double dz, double biasX, double biasZ) {
        long foot = feet[at];
        int rise = y(foot) - y(current), dip = y(current) - routeLow[at];
        // A connected high shoulder and unsearched area beat another trip into
        // bare low ground. Neither a detour nor a descent is forbidden.
        return depth[at] * 0.55 - dx * biasX - dz * biasZ + timberCoverage(foot) * 0.8
            - 2.15 * Math.min(3, Math.max(0, rise)) + 2.6 * Math.max(0, -rise) + 1.8 * Math.max(0, dip - 1);
    }

    private boolean foodBandAllows(int edge, int to, int tick, int floor, boolean connector) {
        if (!outsideScoutBand(to, tick, floor)) return true;
        // Below the scout band, use settled legs only, and only as a connector
        // to another high outlet or fresh habitat; lower rock is not a goal.
        return connector && seen[edge] == Integer.MAX_VALUE;
    }

    private boolean suffixUsable(long from, int tick, int scoutFloor) {
        if (viaFoodConnector && y(endpoint) < egressHighY && !freshForagingTop(find(endpoint), tick)) return false;
        for (int i = cursor; i < length; i++) {
            long to = suffix[i];
            int n = find(from), slot = AgentRouteGraph.slot(from, to);
            int edge = n * SLOTS + slot;
            if (n == 0 || slot < 0 || edges[edge] == 0 || feet[edges[edge]] != to || !usable(edge, tick)
                    || !foodBandAllows(edge, edges[edge], tick, scoutFloor, viaFoodConnector))
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
        viaFoodConnector = false;
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
        foodOutletTried[victim] = false;
        timberVisited[victim] = timberLooked[victim] = false;
        revision++;
        return victim;
    }

    private void clearEdge(int edge) {
        edges[edge] = 0;
        seen[edge] = retryAfter[edge] = 0;
    }
}
