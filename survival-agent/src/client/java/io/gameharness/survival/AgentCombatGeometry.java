package io.gameharness.survival;

import java.util.Arrays;
import java.util.Objects;
import net.minecraft.block.BlockState;
import net.minecraft.block.ShapeContext;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.shape.VoxelShape;
import net.minecraft.util.shape.VoxelShapes;

/**
 * User-authorized, encounter-only collision geometry. Never visual evidence or terrain memory.
 * Queries follow a requested body corridor, stop at its first obstruction, and never expose states.
 * Complete requested clearance boxes must fit the four-metre Euclidean sphere about current feet.
 * Support uses full footprint coverage, not traction/material predictions or future friction.
 * At most 512 loaded checks / collision cells per refresh, including cached unknown cells;
 * one-tick reuse requires unchanged feet, body, pose, life, player, world and encounter token.
 */
final class AgentCombatGeometry {
    static final String PROVENANCE = "GEOMETRY_NATIVE_COMBAT";
    static final double RADIUS = 4;
    private static final double EPS = 1.0e-7;
    private static final double MARGIN = 0.025;
    private static final double APEX = 1.31;
    private static final int CAPACITY = 512;
    private static final int RECTANGLES = 128;

    enum Status { FLAT, STEP_UP, STEP_DOWN, WALL, CEILING, CLIFF, UNKNOWN, STALE }

    /** Internal collision seam; both the native adapter and shape fixtures use the same provider. */
    interface Probe {
        Object world();
        Object player();
        Object pose();
        long life();
        int age();
        boolean alive();
        Vec3d feet();
        Box body();
        BlockPos groundedSupport();
        boolean loaded(int x, int y, int z);
        VoxelShape collision(int x, int y, int z);
        boolean fluid(int x, int y, int z);
    }

    final class Receipt {
        private final long generation;
        private final Status status;
        private final int step;
        private final double distance;
        private final double braking;
        private final BlockPos from;
        private final BlockPos to;
        private final Box corridor;

        private Receipt(Status status, int step, double distance, double braking, BlockPos to, Box corridor) {
            this.generation = AgentCombatGeometry.this.generation;
            this.status = status;
            this.step = step;
            this.distance = distance;
            this.braking = braking;
            this.from = step < 0 && groundedSupport != null ? groundedSupport.up()
                : feet == null ? null : BlockPos.ofFloored(feet);
            this.to = to;
            this.corridor = corridor;
        }

        Status status() { return status; }
        boolean admitted() {
            return (status == Status.FLAT || status == Status.STEP_UP || status == Status.STEP_DOWN)
                && current();
        }
        int step() { return step; }
        double distance() { return distance; }
        double brakingDistance() { return braking; }
        String provenance() { return PROVENANCE; }
        BlockPos from() { return from; }
        BlockPos to() { return to; }
        Box corridor() { return corridor; }

        /** No new probes: an unqueried cell or a box outside this corridor is not clearance. */
        boolean clear(Box sweptBody) {
            return admitted() && contains(corridor, sweptBody) && cachedClear(sweptBody, false);
        }

        /** Fluids of every kind are equally non-dry; their identity is never returned. */
        boolean dry(Box sweptBody) {
            return admitted() && contains(corridor, sweptBody) && cachedClear(sweptBody, true);
        }

        private boolean current() {
            return generation == AgentCombatGeometry.this.generation && fresh(probe, episode, refreshed);
        }
    }

    private final NativeProbe nativeProbe = new NativeProbe();
    private final int[] xs = new int[CAPACITY];
    private final int[] ys = new int[CAPACITY];
    private final int[] zs = new int[CAPACITY];
    private final int[] slots = new int[CAPACITY * 2];
    private final VoxelShape[] shapes = new VoxelShape[CAPACITY];
    private final boolean[] fluids = new boolean[CAPACITY];
    private final int[] orderX = new int[128];
    private final int[] orderY = new int[128];
    private final int[] orderZ = new int[128];
    private final double[] orderD = new double[128];
    private final double[] rx0 = new double[RECTANGLES];
    private final double[] rx1 = new double[RECTANGLES];
    private final double[] rz0 = new double[RECTANGLES];
    private final double[] rz1 = new double[RECTANGLES];
    private final double[] cuts = new double[RECTANGLES * 2 + 2];
    private final VoxelShapes.BoxConsumer supportConsumer = this::supportBox;
    private final VoxelShapes.BoxConsumer collisionConsumer = this::collisionBox;
    private Probe probe;
    private Object world;
    private Object player;
    private Object pose;
    private long life;
    private long episode;
    private long generation;
    private int refreshed;
    private int age;
    private Vec3d feet;
    private Box body;
    private BlockPos groundedSupport;
    private int size;
    private boolean overflow;
    private int rectangles;
    private int cellX;
    private int cellY;
    private int cellZ;
    private double checkMinX;
    private double checkMinY;
    private double checkMinZ;
    private double checkMaxX;
    private double checkMaxY;
    private double checkMaxZ;
    private double supportMin;
    private double supportMax;
    private boolean intersects;
    private boolean horizontalSolid;
    private boolean departureLevelsOnly;
    private boolean sourceContact;

    boolean refresh(MinecraftClient client, long activeEpisode, int tick) {
        nativeProbe.client = client;
        return refresh(nativeProbe, activeEpisode, tick);
    }

    boolean refresh(Probe source, long activeEpisode, int tick) {
        if (activeEpisode == 0 || source == null || !source.alive()
                || source.world() == null || source.player() == null) {
            invalidate();
            return false;
        }
        // Reuse at most one native tick, only at the exact same stance and episode.
        if (fresh(source, activeEpisode, tick)) return true;
        invalidate();
        probe = source;
        world = source.world();
        player = source.player();
        pose = source.pose();
        life = source.life();
        episode = activeEpisode;
        refreshed = tick;
        age = source.age();
        feet = source.feet();
        body = source.body();
        groundedSupport = source.groundedSupport();
        return feet != null && body != null;
    }

    Receipt candidate(MinecraftClient client, long activeEpisode, int tick, double dx, double dz,
            double distance, int step, double brakingDistance) {
        nativeProbe.client = client;
        return candidate(nativeProbe, activeEpisode, tick, dx, dz, distance, step, brakingDistance);
    }

    Receipt candidate(Probe source, long activeEpisode, int tick, double dx, double dz,
            double distance, int step, double brakingDistance) {
        if (!fresh(source, activeEpisode, tick)) {
            invalidate();
            return receipt(Status.STALE, step, distance, brakingDistance, null, null);
        }
        double length = Math.hypot(dx, dz);
        if (!Double.isFinite(length) || length < EPS || !Double.isFinite(distance)
                || !Double.isFinite(brakingDistance) || distance <= 0 || brakingDistance < 0
                || step < -1 || step > 1 || step < 0 && groundedSupport == null) {
            return receipt(Status.UNKNOWN, step, distance, brakingDistance, null, null);
        }
        dx /= length;
        dz /= length;
        double total = distance + brakingDistance;
        Box envelope = new Box(body.minX - MARGIN, body.minY, body.minZ - MARGIN,
            body.maxX + MARGIN, body.maxY + 0.05, body.maxZ + MARGIN);
        Box landing = envelope.offset(dx * distance, step, dz * distance);
        double endX = dx * total;
        double endZ = dz * total;
        Box corridor = new Box(envelope.minX + Math.min(0, endX),
            envelope.minY + Math.min(0, step), envelope.minZ + Math.min(0, endZ),
            envelope.maxX + Math.max(0, endX), envelope.maxY + (step > 0 ? APEX : 0),
            envelope.maxZ + Math.max(0, endZ));
        if (!bounded(corridor)) return receipt(Status.UNKNOWN, step, distance, brakingDistance, null, null);
        BlockPos to = BlockPos.ofFloored(feet.add(dx * distance, step, dz * distance));
        // Grounded toes may already overhang a checked down-step. Require actual source-top
        // overlap and cover every remaining part by that same connected, one-block lower top.
        departureLevelsOnly = step < 0;
        sourceContact = false;
        Status departure = support(envelope, feet.y + Math.min(0, step), feet.y);
        departureLevelsOnly = false;
        if (step < 0 && departure == null && !sourceContact) departure = Status.CLIFF;
        if (departure != null) return receipt(departure, step, distance, brakingDistance, to, null);

        // Upward launch is checked before any forward or raised-space probe.
        if (step > 0) {
            Status launch = clearVolume(envelope.minX, envelope.minY, envelope.minZ,
                envelope.maxX, envelope.maxY + APEX, envelope.maxZ, dx, dz);
            if (launch != null) return receipt(launch == Status.WALL ? Status.CEILING : launch,
                step, distance, brakingDistance, to, null);
        }
        double raised = Math.max(0, step);
        double previousX = 0;
        double previousZ = 0;
        double previousMinY = envelope.minY + raised;
        double previousMaxY = envelope.maxY + (step > 0 ? APEX : raised);
        int segments = Math.max(1, (int) Math.ceil(total / 0.125));
        for (int i = 1; i <= segments; i++) {
            double along = total * i / segments;
            // A descent stays at launch height until the landing, then checks the full drop.
            double height = step < 0 && along >= distance ? step : raised;
            double x = dx * along;
            double z = dz * along;
            double minY = envelope.minY + height;
            double maxY = envelope.maxY + (step > 0 ? APEX : height);
            Status obstruction = clearVolume(
                envelope.minX + Math.min(previousX, x), Math.min(previousMinY, minY),
                envelope.minZ + Math.min(previousZ, z), envelope.maxX + Math.max(previousX, x),
                Math.max(previousMaxY, maxY), envelope.maxZ + Math.max(previousZ, z), dx, dz);
            if (obstruction != null) return receipt(obstruction, step, distance, brakingDistance, to, null);
            double minimum = feet.y + Math.min(0, step);
            double maximum = feet.y + Math.max(0, step);
            boolean finalLevel = along >= distance;
            Status support = support(envelope.minX + x, envelope.minZ + z,
                envelope.maxX + x, envelope.maxZ + z, finalLevel ? feet.y + step : minimum,
                finalLevel ? feet.y + step : maximum);
            if (support != null) return receipt(support, step, distance, brakingDistance, to, null);
            previousX = x;
            previousZ = z;
            previousMinY = minY;
            previousMaxY = maxY;
        }
        // A short braking tail must not skip the exact landing height.
        Status contact = clearVolume(landing, dx, dz);
        if (contact == null) contact = support(landing, feet.y + step, feet.y + step);
        if (contact != null) return receipt(contact, step, distance, brakingDistance, to, null);
        return receipt(step == 0 ? Status.FLAT : step > 0 ? Status.STEP_UP : Status.STEP_DOWN,
            step, distance, brakingDistance, to, corridor);
    }

    void invalidate() {
        Arrays.fill(shapes, 0, size, null);
        Arrays.fill(slots, 0);
        size = 0;
        overflow = false;
        probe = null;
        world = player = pose = null;
        feet = null;
        body = null;
        groundedSupport = null;
        episode = 0;
        nativeProbe.state = null;
        nativeProbe.context = null;
        nativeProbe.contextPlayer = null;
        nativeProbe.contextMainItem = null;
        generation++;
    }

    private boolean fresh(Probe source, long token, int tick) {
        return source != null && probe == source && token != 0 && token == episode
            && tick >= refreshed && tick - refreshed <= 1 && source.alive()
            && source.world() == world && source.player() == player && source.pose() == pose
            && source.life() == life && source.age() >= age && source.age() - age <= 1
            && (source != nativeProbe || nativeProbe.contextCurrent())
            && Objects.equals(groundedSupport, source.groundedSupport())
            && feet != null && body != null && feet.equals(source.feet()) && body.equals(source.body());
    }

    private Receipt receipt(Status status, int step, double distance, double braking, BlockPos to, Box bounds) {
        return new Receipt(status, step, distance, braking, to, bounds);
    }

    private boolean bounded(Box box) {
        return bounded(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
    }

    private boolean bounded(double minX, double minY, double minZ, double maxX, double maxY, double maxZ) {
        double x = Math.max(Math.abs(minX - feet.x), Math.abs(maxX - feet.x));
        double z = Math.max(Math.abs(minZ - feet.z), Math.abs(maxZ - feet.z));
        double y = Math.max(Math.abs(minY - feet.y), Math.abs(maxY - feet.y));
        return x * x + y * y + z * z <= RADIUS * RADIUS + EPS;
    }

    private int cell(int x, int y, int z, boolean query) {
        int slot = (x * 73428767 ^ y * 912931 ^ z * 19349663) & (slots.length - 1);
        while (slots[slot] != 0) {
            int found = slots[slot] - 1;
            if (xs[found] == x && ys[found] == y && zs[found] == z) return shapes[found] == null ? -1 : found;
            slot = (slot + 1) & (slots.length - 1);
        }
        if (!query || size == CAPACITY || !cellInRange(x, y, z)) return -1;
        int i = size++;
        xs[i] = x;
        ys[i] = y;
        zs[i] = z;
        slots[slot] = i + 1;
        // Cache unknown as well: repeated refusals cannot produce unbounded loaded checks.
        if (!probe.loaded(x, y, z)) return -1;
        shapes[i] = probe.collision(x, y, z);
        fluids[i] = probe.fluid(x, y, z);
        return shapes[i] == null ? -1 : i;
    }

    private boolean cellInRange(int x, int y, int z) {
        double dx = Math.max(0, Math.max(x - feet.x, feet.x - x - 1));
        double dy = Math.max(0, Math.max(y - feet.y, feet.y - y - 1));
        double dz = Math.max(0, Math.max(z - feet.z, feet.z - z - 1));
        return dx * dx + dy * dy + dz * dz <= RADIUS * RADIUS + EPS;
    }

    private Status clearVolume(Box box, double dx, double dz) {
        return clearVolume(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, dx, dz);
    }

    private Status clearVolume(double minX, double minY, double minZ, double maxX, double maxY,
            double maxZ, double dx, double dz) {
        if (!bounded(minX, minY, minZ, maxX, maxY, maxZ)) return Status.UNKNOWN;
        int count = 0;
        for (int x = MathHelper.floor(minX + EPS); x <= MathHelper.floor(maxX - EPS); x++) {
            for (int z = MathHelper.floor(minZ + EPS); z <= MathHelper.floor(maxZ - EPS); z++) {
                for (int y = MathHelper.floor(minY + EPS); y <= MathHelper.floor(maxY - EPS); y++) {
                    if (count == orderX.length) return Status.UNKNOWN;
                    double d = (x + 0.5 - feet.x) * dx + (z + 0.5 - feet.z) * dz;
                    int at = count++;
                    while (at > 0 && orderD[at - 1] > d) {
                        orderX[at] = orderX[at - 1];
                        orderY[at] = orderY[at - 1];
                        orderZ[at] = orderZ[at - 1];
                        orderD[at] = orderD[at - 1];
                        at--;
                    }
                    orderX[at] = x;
                    orderY[at] = y;
                    orderZ[at] = z;
                    orderD[at] = d;
                }
            }
        }
        checking(minX, minY, minZ, maxX, maxY, maxZ);
        for (int i = 0; i < count; i++) {
            int index = cell(orderX[i], orderY[i], orderZ[i], true);
            if (index < 0 || fluids[index]) return Status.UNKNOWN;
            cellX = xs[index];
            cellY = ys[index];
            cellZ = zs[index];
            intersects = false;
            shapes[index].forEachBox(collisionConsumer);
            if (intersects) return cellY >= feet.y + 1 ? Status.CEILING : Status.WALL;
        }
        return null;
    }

    private void collisionBox(double x0, double y0, double z0, double x1, double y1, double z1) {
        if (checkMinX < x1 + cellX - EPS && checkMaxX > x0 + cellX + EPS
                && checkMinY < y1 + cellY - EPS && checkMaxY > y0 + cellY + EPS
                && checkMinZ < z1 + cellZ - EPS && checkMaxZ > z0 + cellZ + EPS) intersects = true;
    }

    private Status support(Box standing, double min, double max) {
        return support(standing.minX, standing.minZ, standing.maxX, standing.maxZ, min, max);
    }

    private Status support(double minX, double minZ, double maxX, double maxZ, double min, double max) {
        checking(minX, min, minZ, maxX, max, maxZ);
        supportMin = min;
        supportMax = max;
        rectangles = 0;
        overflow = false;
        for (int x = MathHelper.floor(minX + EPS); x <= MathHelper.floor(maxX - EPS); x++) {
            for (int z = MathHelper.floor(minZ + EPS); z <= MathHelper.floor(maxZ - EPS); z++) {
                for (int y = MathHelper.floor(max - EPS); y >= MathHelper.floor(min - EPS); y--) {
                    int index = cell(x, y, z, true);
                    if (index < 0 || fluids[index]) return Status.UNKNOWN;
                    cellX = x;
                    cellY = y;
                    cellZ = z;
                    horizontalSolid = false;
                    shapes[index].forEachBox(supportConsumer);
                    // First solid surface only: do not look beneath a partial shelf.
                    if (horizontalSolid) break;
                }
            }
        }
        if (overflow) return Status.UNKNOWN;
        return covered(minX, minZ, maxX, maxZ) ? null : Status.CLIFF;
    }

    private void supportBox(double x0, double y0, double z0, double x1, double y1, double z1) {
        x0 = Math.max(x0 + cellX, checkMinX);
        x1 = Math.min(x1 + cellX, checkMaxX);
        z0 = Math.max(z0 + cellZ, checkMinZ);
        z1 = Math.min(z1 + cellZ, checkMaxZ);
        if (x1 - x0 <= EPS || z1 - z0 <= EPS) return;
        horizontalSolid = true;
        double top = y1 + cellY;
        if (top < supportMin - EPS || top > supportMax + EPS) return;
        if (departureLevelsOnly) {
            if (Math.abs(top - supportMin) > EPS && Math.abs(top - supportMax) > EPS) return;
            if (cellX == groundedSupport.getX() && cellY == groundedSupport.getY()
                    && cellZ == groundedSupport.getZ() && Math.abs(top - feet.y) <= EPS
                    && Math.min(x1, body.maxX) - Math.max(x0, body.minX) > EPS
                    && Math.min(z1, body.maxZ) - Math.max(z0, body.minZ) > EPS) sourceContact = true;
        }
        if (rectangles == RECTANGLES) { overflow = true; return; }
        rx0[rectangles] = x0;
        rx1[rectangles] = x1;
        rz0[rectangles] = z0;
        rz1[rectangles++] = z1;
    }

    /** Exact rectangle-union coverage, not a few point samples that could miss a narrow hole. */
    private boolean covered(double minX, double minZ, double maxX, double maxZ) {
        int count = 0;
        cuts[count++] = minX;
        cuts[count++] = maxX;
        for (int i = 0; i < rectangles; i++) {
            cuts[count++] = rx0[i];
            cuts[count++] = rx1[i];
        }
        Arrays.sort(cuts, 0, count);
        for (int i = 1; i < count; i++) {
            if (cuts[i] - cuts[i - 1] <= EPS) continue;
            double x = (cuts[i] + cuts[i - 1]) * 0.5;
            double z = minZ;
            while (z < maxZ - EPS) {
                double next = z;
                for (int r = 0; r < rectangles; r++) {
                    if (rx0[r] <= x && rx1[r] >= x && rz0[r] <= z + EPS) next = Math.max(next, rz1[r]);
                }
                if (next <= z + EPS) return false;
                z = next;
            }
        }
        return true;
    }

    private boolean cachedClear(Box box, boolean dryOnly) {
        for (int x = MathHelper.floor(box.minX + EPS); x <= MathHelper.floor(box.maxX - EPS); x++) {
            for (int z = MathHelper.floor(box.minZ + EPS); z <= MathHelper.floor(box.maxZ - EPS); z++) {
                for (int y = MathHelper.floor(box.minY + EPS); y <= MathHelper.floor(box.maxY - EPS); y++) {
                    int index = cell(x, y, z, false);
                    if (index < 0 || fluids[index]) return false;
                    if (dryOnly) continue;
                    checking(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
                    cellX = x;
                    cellY = y;
                    cellZ = z;
                    intersects = false;
                    shapes[index].forEachBox(collisionConsumer);
                    if (intersects) return false;
                }
            }
        }
        return true;
    }

    private void checking(double minX, double minY, double minZ, double maxX, double maxY, double maxZ) {
        checkMinX = minX;
        checkMinY = minY;
        checkMinZ = minZ;
        checkMaxX = maxX;
        checkMaxY = maxY;
        checkMaxZ = maxZ;
    }

    private static boolean contains(Box outer, Box inner) {
        return outer != null && inner != null && inner.minX >= outer.minX - EPS
            && inner.maxX <= outer.maxX + EPS && inner.minY >= outer.minY - EPS
            && inner.maxY <= outer.maxY + EPS && inner.minZ >= outer.minZ - EPS
            && inner.maxZ <= outer.maxZ + EPS;
    }

    private static final class NativeProbe implements Probe {
        private MinecraftClient client;
        private final BlockPos.Mutable position = new BlockPos.Mutable();
        private ShapeContext context;
        private Object contextPlayer;
        private Object contextMainItem;
        private boolean contextDescending;
        private BlockState state;

        public Object world() { return client == null ? null : client.world; }
        public Object player() { return client == null ? null : client.player; }
        public Object pose() { return client.player.getPose(); }
        public long life() { return 0; } // A respawn replaces the native player object.
        public int age() { return client.player.age; }
        public boolean alive() {
            return client != null && client.player != null && client.world != null
                && client.player.isAlive() && !client.player.isRemoved();
        }
        public Vec3d feet() { return client.player.getPos(); }
        public Box body() { return client.player.getBoundingBox(); }
        public BlockPos groundedSupport() {
            return client.player.isOnGround() ? client.player.supportingBlockPos.orElse(null) : null;
        }
        public boolean loaded(int x, int y, int z) { return client.world.isChunkLoaded(x >> 4, z >> 4); }
        public VoxelShape collision(int x, int y, int z) {
            if (context == null) {
                contextPlayer = client.player;
                contextMainItem = client.player.getMainHandStack().getItem();
                contextDescending = client.player.isDescending();
                context = ShapeContext.of(client.player);
            }
            position.set(x, y, z);
            state = client.world.getBlockState(position);
            return state.getCollisionShape(client.world, position, context);
        }
        public boolean fluid(int x, int y, int z) {
            // Called immediately after collision for this cell; no second block lookup.
            return !state.getFluidState().isEmpty();
        }

        private boolean contextCurrent() {
            return context == null || contextPlayer == client.player
                && contextMainItem == client.player.getMainHandStack().getItem()
                && contextDescending == client.player.isDescending();
        }
    }
}
