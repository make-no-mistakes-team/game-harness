package io.gameharness.survival;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

import static io.gameharness.survival.AgentBody.WetEscapeMedium.*;

/** Recovery for incidental immersion, not the controller for a planned water route. */
final class AgentWaterEscape {
    private static final int STALLED_TICKS = 32, DRIFT_TICKS = 9, MAX_DRIVES = 5, MAX_EPISODE_TICKS = 390;
    private static final int DRIVE_TICKS = 44, NO_GAIN_TICKS = 15, RECHECK_TICKS = 39, DRY_TICKS = 5;
    private static final int LIP_TICKS = 15;
    private static final int RETURN_LEGS = 8, RETURN_TICKS = 48, SURFACE_TICKS = 26;
    private static final int RETURN_PROOF_TICKS = 8;
    private static final int MIN_START_AIR = 150;
    static final int MIN_WORK_AIR = 105;
    private static final double[] DISTANCES = {0.90, 1.51, 2.15};
    private static final int[] FAN = {0, -29, 29};
    private static final Direction[] PLUG_FACES = {
        Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST
    };
    private static final Predicate<ItemStack> FILL = stack -> stack.isOf(Items.DIRT);

    enum Result { WORKING, BLOCKED, LANDED, INTERRUPTED }
    enum Phase { RETURN, SURFACE, DRIFT, SCAN, DRIVE, PLUG, DRAIN, UNPLUG, BLOCKED }
    private record Lane(Vec3d landing, BlockPos floor, BlockState support, boolean bank, double score) {}
    private record Plug(BlockPos cell, Vec3d water, BlockHitResult attachment) {}
    private record Sight(Vec3d point, AgentBody.WetEscapeMedium medium) {}

    /** Only actual settled crossings supply this chain. It contains no claim about the current waterline. */
    static final class ReturnCorridor {
        private final List<BlockPos> walked;
        private int cursor;

        ReturnCorridor(List<BlockPos> walked) {
            this.walked = List.copyOf(walked.subList(Math.max(0, walked.size() - RETURN_LEGS - 1), walked.size()));
            cursor = this.walked.size() - 1;
        }

        BlockPos from() { return walked.get(cursor); }
        BlockPos to() { return walked.get(cursor - 1); }

        boolean arrived(Vec3d feet) {
            Vec3d landing = Vec3d.ofBottomCenter(to());
            return distance(feet, landing) <= 0.24 && Math.abs(feet.y - landing.y) <= 0.25;
        }

        boolean needsDescent(Vec3d feet, Vec3d landing) {
            return feet.y > Math.max(from().getY(), to().getY()) + 0.24
                || distance(feet, landing) <= 0.22 && feet.y > landing.y + 0.22;
        }

        boolean next() {
            if (cursor <= 1) return false;
            cursor--;
            return true;
        }
    }

    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentHands hands;
    private final Predicate<BlockPos> protectedBlock;
    private final Predicate<BlockHitResult> safeSupport;
    private final Set<BlockPos> tried = new HashSet<>(8);
    private final Sight[] localEvidence = new Sight[12];
    private ClientWorld world;
    private ClientPlayerEntity player;
    private Phase phase;
    private Vec3d wetAnchor, recentDry, olderDry, origin, driftStart, blockedAt;
    private int wetAnchorAge, recentDryAge, olderDryAge, dryTicks, lastActionTick, dryAge, entered, began;
    private int sector, proofAt, actionAt, gainAt, lipAt, attempts, drives, dryLossAt, itemBefore, evidenceCount;
    private float firstYaw;
    private double driftX, driftZ, bestDistance, originalDistance;
    private boolean lowView, edited, useIssued, confirmedPlug, undoFinished, sawFrame, renderedScan, allowEdits, emergency;
    private Lane target, pocket;
    private ReturnCorridor returnWay;
    private boolean urgentAir, retreatWet, checkedInputs;
    private Vec3d breathingPoint;
    private final Function<Vec3d, AgentBody.WetEscapeMedium> returnSight = this::sample;
    private Plug plug, observedPlug;
    private Block placedBlock;
    private String status = "";

    AgentWaterEscape(MinecraftClient client, AgentBody body, AgentHands hands,
                     Predicate<BlockPos> protectedBlock, Predicate<BlockHitResult> safeSupport) {
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.protectedBlock = protectedBlock;
        this.safeSupport = safeSupport;
    }

    void observe() {
        var current = client.player;
        if (world != client.world || player != current) {
            world = client.world;
            player = current;
            recentDry = olderDry = wetAnchor = null;
            dryTicks = 0;
            clearEpisode();
        }
        Vec3d feet = player.getPos();
        if (dryGround()) {
            if (recentDry == null || distance(feet, recentDry) > 0.42 || Math.abs(feet.y - recentDry.y) > 0.12) {
                olderDry = recentDry;
                olderDryAge = recentDryAge;
                recentDry = feet;
            }
            recentDryAge = player.age;
            wetAnchor = null;
            dryTicks = dryAge + 1 == player.age ? dryTicks + 1 : 1;
            dryAge = player.age;
        } else {
            dryTicks = 0;
            if (!player.isTouchingWater() || player.hasVehicle()) wetAnchor = null;
            else if (wetAnchor == null || distance(wetAnchor, feet) >= 0.72) {
                wetAnchor = feet;
                wetAnchorAge = player.age;
            }
        }
    }

    boolean stalled() {
        return wetAnchor != null && player.age - wetAnchorAge >= STALLED_TICKS
            && player.getAir() >= MIN_START_AIR && !player.isInLava() && !player.isOnFire();
    }

    String status() { return status; }
    int attempts() { return attempts; }
    boolean blocked() { return phase == Phase.BLOCKED; }
    boolean retracing() { return returnWay != null; }

    void broken(BlockPos position, BlockState state) {
        if (phase == Phase.UNPLUG && confirmedPlug && position.equals(plug.cell()) && state.isOf(placedBlock))
            undoFinished = true;
    }

    void clearEpisode() {
        phase = null;
        target = pocket = null;
        plug = observedPlug = null;
        origin = null;
        wetAnchor = null;
        returnWay = null;
        breathingPoint = null;
    }

    void start(boolean allowEdits) {
        reset(allowEdits, false);
        beginDrift(began);
    }

    /** Damage needs a bank now, not a stall diagnosis or a flow edit. */
    void startEmergency() {
        reset(false, true);
        body.pauseWork();
        beginScan(began, "checking for a witnessed bank after damage");
    }

    /** Start at the last dry crossing, before waiting for a generic stall or buoyancy. */
    void startReturn(List<BlockPos> walked) {
        reset(false, false);
        body.pauseWork();
        checkedInputs = true;
        returnWay = new ReturnCorridor(walked);
        retreatWet = player.isTouchingWater();
        beginReturn(began);
    }

    /** Air takes priority over ordinary work, not over a verified stroke already in progress. */
    void startForAir() {
        reset(false, false);
        body.pauseWork();
        checkedInputs = true;
        beginSurface(began);
    }

    private void reset(boolean allowEdits, boolean emergency) {
        tried.clear();
        attempts = drives = 0;
        edited = false;
        urgentAir = checkedInputs = false;
        returnWay = null;
        breathingPoint = null;
        this.allowEdits = allowEdits;
        this.emergency = emergency;
        origin = player.getPos();
        began = body.actionTick();
        driftX = driftZ = 0;
        dryLossAt = 0;
        sawFrame = renderedScan = false;
        lastActionTick = began - 1;
    }

    private void beginDrift(int now) {
        body.pauseWork();
        phase = Phase.DRIFT;
        entered = now;
        driftStart = null;
        dryLossAt = 0;
        sawFrame = renderedScan = false;
        status = "water recovery: measuring drift without directional input";
    }

    Result step() {
        int now = body.actionTick();
        int gap = now - lastActionTick;
        lastActionTick = now;
        if (origin == null || player.hasVehicle()) return Result.INTERRUPTED;
        if (player.isTouchingWater() && player.getAir() < MIN_WORK_AIR && !urgentAir) {
            urgentAir = checkedInputs = true;
            allowEdits = false;
            if (phase == Phase.SCAN && pocket != null && drives < MAX_DRIVES) startDrive(now, pocket);
            else if (interruptForAir(phase)) {
                body.pauseWork();
                beginSurface(now);
            }
        }
        if (phase == Phase.RETURN) return retreat(now);
        if (checkedInputs) body.holdWetEscape();
        if (dryTicks >= DRY_TICKS) {
            status = "water recovery: settled dry footing at " + player.getBlockPos().toShortString();
            body.pauseWork();
            return Result.LANDED;
        }
        if (!player.isTouchingWater()) {
            if (dryLossAt == 0) dryLossAt = now;
            return now - dryLossAt <= 12 ? Result.WORKING : Result.INTERRUPTED;
        }
        dryLossAt = 0;
        if (phase == Phase.BLOCKED) return reconsider(now);
        if (gap > 1 && !checkedInputs
                && phase != Phase.PLUG && phase != Phase.DRAIN && phase != Phase.UNPLUG) beginDrift(now);
        if (now - began >= MAX_EPISODE_TICKS && phase != Phase.DRAIN && phase != Phase.UNPLUG)
            return block(now, "bounded escape ended without dry footing");
        switch (phase) {
            case SURFACE -> surface(now);
            case DRIFT -> measure(now);
            case SCAN -> { return scan(now); }
            case DRIVE -> drive(now);
            case PLUG -> place(now);
            case DRAIN -> drain(now);
            case UNPLUG -> unplug(now);
            default -> { }
        }
        return Result.WORKING;
    }

    static boolean interruptForAir(Phase phase) {
        return phase != Phase.RETURN && phase != Phase.DRIVE && phase != Phase.SURFACE;
    }

    private void beginReturn(int now) {
        phase = Phase.RETURN;
        entered = gainAt = now;
        proofAt = now - RETURN_PROOF_TICKS - 1;
        bestDistance = player.getPos().distanceTo(Vec3d.ofBottomCenter(returnWay.to()));
        status = "water recovery: rechecking the walked exit toward " + returnWay.to().toShortString();
    }

    private Result retreat(int now) {
        boolean wet = player.isTouchingWater();
        if (wet && !retreatWet) proofAt = now - RETURN_PROOF_TICKS - 1;
        retreatWet |= wet;
        body.holdWetEscape();
        Vec3d feet = player.getPos(), landing = Vec3d.ofBottomCenter(returnWay.to());
        double remaining = feet.distanceTo(landing);
        if (remaining < bestDistance - 0.06) {
            gainAt = now;
            bestDistance = remaining;
        }
        if (returnWay.arrived(feet)) {
            if (!wet && (retreatWet ? dryTicks >= DRY_TICKS : dryGround())) {
                status = "water recovery: settled dry footing on the walked exit at " + returnWay.to().toShortString();
                body.pauseWork();
                return Result.LANDED;
            }
            if (wet && returnWay.next()) beginReturn(now);
            else if (wet) beginSurface(now);
            return Result.WORKING;
        }
        if (now - began >= MAX_EPISODE_TICKS || now - entered >= RETURN_TICKS
                || now - gainAt >= 30 || distance(feet, landing) > 2.28
                || feet.y < landing.y - 1.04) {
            if (!wet) return Result.INTERRUPTED;
            beginSurface(now);
            return Result.WORKING;
        }

        BlockPos from = returnWay.from(), to = returnWay.to();
        float yaw = yaw(feet, landing);
        double horizontal = distance(feet, landing);
        if (wet && returnWay.needsDescent(feet, landing)) {
            // Lower back toward the last occupied height. Do not ascend into the
            // new opening, and don't force a diagonal stroke through the stair lip.
            float pitch = 83;
            float exit = yaw(Vec3d.ofBottomCenter(from), landing);
            body.turnUrgent(exit, pitch);
            if (body.renderedDirection(exit, pitch, 15) && body.wetEscapeDrop(0.18)
                    && open(sample(feet.add(0, -0.19, 0)))) {
                body.swimDown();
                status = "water recovery: descending the rechecked return corridor";
            }
            return Result.WORKING;
        }
        double rise = landing.y - feet.y;
        if (horizontal <= 0.20 || rise > 1.04) return Result.WORKING;
        double width = player.getWidth() * 0.5 - 0.06;
        double sideX = (landing.z - feet.z) / horizontal * width;
        double sideZ = (feet.x - landing.x) / horizontal * width;
        Vec3d opening = landing.add(0, MathHelper.clamp(feet.y - landing.y + 0.74, 0.65, 1.83), 0);
        float pitch = (float) Math.toDegrees(Math.atan2(player.getEyeY() - opening.y, horizontal));
        body.turnUrgent(yaw, pitch);
        if (!body.renderedDirection(yaw, pitch, 14) || !returnOpening(opening, sideX, sideZ, returnSight, wet))
            return Result.WORKING;
        AgentBody.WetEscapeMedium low = sample(landing.add(0, 0.10, 0));
        if (returnMedium(low, wet)) {
            if (wet) proofAt = now;
            else {
                // Dry admission still needs a currently dry landing and its full support.
                BlockHitResult floor = body.wetEscapeFloor(landing.add(0, -0.021, 0));
                if (floor != null && floor.getBlockPos().equals(to.down()) && safeSupport.test(floor))
                    proofAt = now;
            }
        } else if (low != UNSEEN) {
            proofAt = now - RETURN_PROOF_TICKS - 1;
            return Result.WORKING;
        }
        if (now - proofAt > RETURN_PROOF_TICKS) return Result.WORKING;
        if (!wet && to.getY() > from.getY()) {
            if (body.dryRouteVeto(from, to) == AgentBody.DryRouteVeto.CLEAR)
                body.driveDryRoute(from, to, Direction.fromHorizontalDegrees(yaw));
            return Result.WORKING;
        }
        boolean lift = rise > 0.035 && rise <= 1.04 && body.wetEscapeRise(rise);
        if (lift) body.jump();
        if (!body.wetEscapeSweep(landing, 0, 0, 0)) return Result.WORKING;
        body.driveWetEscape(lift);
        status = "water recovery: retracing the rechecked walked exit toward " + to.toShortString();
        return Result.WORKING;
    }

    static boolean returnOpening(Vec3d mid, double sideX, double sideZ,
                                 Function<Vec3d, AgentBody.WetEscapeMedium> see, boolean inWater) {
        return returnMedium(see.apply(mid), inWater) && returnMedium(see.apply(mid.add(sideX, 0, sideZ)), inWater)
            && returnMedium(see.apply(mid.add(-sideX, 0, -sideZ)), inWater);
    }

    private static boolean returnMedium(AgentBody.WetEscapeMedium medium, boolean inWater) {
        return medium == AIR || inWater && water(medium);
    }

    private void beginSurface(int now) {
        phase = Phase.SURFACE;
        entered = now;
        breathingPoint = null;
        firstYaw = player.getYaw();
        status = "water recovery: checking for reachable air above the current position";
    }

    private void surface(int now) {
        if (!player.isSubmergedInWater() || now - entered >= SURFACE_TICKS) {
            beginScan(now, "checking alternate banks and air pockets");
            return;
        }
        body.turnUrgent(firstYaw, -83);
        if (!body.renderedDirection(firstYaw, -83, 16)) return;
        // Only a positive AIR observation through the column opens the upward stroke.
        // A roof (or darkness/occlusion) never causes a jump plus blind forward.
        if (breathingPoint == null) {
            Vec3d eye = player.getEyePos();
            Vec3d near = eye.add(0, 0.44, 0);
            Vec3d far = eye.add(0, 0.90, 0);
            if (sample(near) == AIR) breathingPoint = near;
            else if (sample(far) == AIR) breathingPoint = far;
            else {
                beginScan(now, "air above is not witnessed; checking alternate banks and air pockets");
                return;
            }
        }
        double rise = breathingPoint.y - player.getEyeY();
        if (rise >= -0.08 && distance(player.getEyePos(), breathingPoint) < 0.27
                && sample(breathingPoint) == AIR && body.wetEscapeRise(rise)) {
            body.jump();
            status = "water recovery: rising toward witnessed air";
        }
    }

    private void measure(int now) {
        if (now - entered < 3) return;
        if (driftStart == null) driftStart = player.getPos();
        if (now - entered < DRIFT_TICKS) return;
        Vec3d feet = player.getPos();
        driftX = (feet.x - driftStart.x) / (DRIFT_TICKS - 3);
        driftZ = (feet.z - driftStart.z) / (DRIFT_TICKS - 3);
        beginScan(now, "checking visible banks and shallow sides"
            + (Math.hypot(driftX, driftZ) >= 0.006 ? " from measured drift" : "; no useful passive drift"));
    }

    private void beginScan(int now, String reason) {
        phase = Phase.SCAN;
        entered = now;
        sector = evidenceCount = 0;
        lowView = false;
        pocket = null;
        observedPlug = null;
        Vec3d feet = player.getPos();
        Vec3d prior = nearbyDry(feet, recentDry, recentDryAge) ? recentDry
            : nearbyDry(feet, olderDry, olderDryAge) ? olderDry : null;
        firstYaw = prior == null ? player.getYaw() : yaw(feet, prior);
        status = "water recovery: " + reason;
    }

    private boolean nearbyDry(Vec3d feet, Vec3d seen, int age) {
        return seen != null && player.age - age <= 160 && Math.abs(seen.y - feet.y) <= 1.04
            && distance(feet, seen) <= 2.65 && distance(feet, seen) >= 0.52;
    }

    private Result scan(int now) {
        sawFrame |= body.hasRecentView();
        if (sector == 4 || drives >= MAX_DRIVES) {
            if (pocket != null && drives < MAX_DRIVES) startDrive(now, pocket);
            else if (observedPlug != null && allowEdits && !edited) {
                plug = observedPlug;
                edited = true;
                useIssued = confirmedPlug = undoFinished = false;
                attempts++;
                phase = Phase.PLUG;
                entered = now;
                status = "water recovery: checking a visible attachment to isolate the incoming flow";
            } else return block(now, !renderedScan ? "no usable rendered view of the wet corridor"
                : "no witnessed reachable bank or untried air pocket; "
                    + (edited ? "the checked cut-off did not drain the footing"
                        + (undoFinished ? "; removed the owned block" : "") : "no safe visible flow cut-off"));
            return Result.WORKING;
        }
        float yaw = firstYaw + sector * 90;
        float pitch = lowView ? 48 : 27;
        if (emergency || checkedInputs) body.turnUrgent(yaw, pitch);
        else body.turnScan(yaw, pitch);
        if (!body.renderedDirection(yaw, pitch, 11) && now - entered < 33) return Result.WORKING;
        if (body.renderedDirection(yaw, pitch, 15)) {
            renderedScan = true;
            Vec3d feet = player.getPos();
            Lane bank = null;
            for (int offset : FAN) {
                double angle = Math.toRadians(yaw + offset);
                double x = -Math.sin(angle), z = Math.cos(angle);
                for (double reach : DISTANCES) {
                    BlockPos cell = BlockPos.ofFloored(feet.x + x * reach, feet.y, feet.z + z * reach);
                    if (drives < MAX_DRIVES) {
                        Lane lane = lane(feet, cell);
                        if (lane != null) {
                            if (lane.bank()) bank = better(bank, lane);
                            else pocket = better(pocket, lane);
                        }
                    }
                    if (observedPlug == null && !edited) observedPlug = findPlug(feet, cell);
                }
            }
            if (bank != null) {
                startDrive(now, bank);
                return Result.WORKING;
            }
        }
        // Retain both the shallow headroom view and the steeper floor/flow view.
        if (lowView) sector++;
        lowView = !lowView;
        entered = now;
        return Result.WORKING;
    }

    private static Lane better(Lane old, Lane next) {
        return old == null || next.score() > old.score() ? next : old;
    }

    private Lane lane(Vec3d feet, BlockPos cell) {
        double x = cell.getX() + 0.5, z = cell.getZ() + 0.5;
        double dx = x - feet.x, dz = z - feet.z;
        double range = Math.hypot(dx, dz);
        if (range < 0.61 || range > 2.55) return null;
        for (int dy = 1; dy >= -1; dy--) {
            double level = cell.getY() + dy;
            if (tried.contains(cell.up(dy))) continue;
            if (level - feet.y > 1.04 || feet.y - level > 1.13) continue;
            Vec3d landing = new Vec3d(x, level, z);
            Vec3d floorPoint = landing.add(0, -0.021, 0);
            BlockHitResult floor = body.wetEscapeFloor(floorPoint);
            if (floor == null || !floor.getBlockPos().equals(cell.up(dy - 1)) || !safeSupport.test(floor)) continue;
            AgentBody.WetEscapeMedium low = sample(landing.add(0, 0.067, 0));
            if (!open(low) || sample(landing.add(0, 1.67, 0)) != AIR) continue;
            boolean bank = low == AIR;
            // A flooded shelf is not a returnable alternative if we must yield height
            // to the current before getting there, or climb up without a proved dry top.
            if (!bank && Math.abs(level - feet.y) > 0.28) continue;
            double width = player.getWidth() * 0.5 - 0.025;
            double sx = dz / range * width, sz = -dx / range * width;
            if (!open(sample(landing.add(sx, 0.72, sz))) || !open(sample(landing.add(-sx, 0.72, -sz)))) continue;
            if (range > 1.42 && (!open(sample(new Vec3d(feet.x + dx * 0.53,
                    Math.max(level, feet.y) + 1.15, feet.z + dz * 0.53)))
                    || body.wetEscapeFloor(new Vec3d(feet.x + dx * 0.52,
                        Math.floor(feet.y + 0.04) - 1.02, feet.z + dz * 0.52)) == null)) continue;
            double rise = Math.max(0, level - feet.y);
            if (!body.wetEscapeSweep(landing, rise, 0, 0)) continue;
            // A real prior footing trumps a new one. Among pockets prefer cross-current/with-current
            // lanes over another push into the same observed flow.
            double assist = (dx * driftX + dz * driftZ) / range;
            double score = (bank ? 4 : 0) + (nearbyDry(feet, recentDry, recentDryAge)
                && distance(landing, recentDry) < 0.48 ? 2 : 0) + 45 * assist - rise * 0.25 - range * 0.21;
            return new Lane(landing, floor.getBlockPos(), world.getBlockState(floor.getBlockPos()), bank, score);
        }
        // No hidden floor probe may establish a landing. An already floating player can,
        // however, cross a short, visibly continuous surface without making a dry jump/drop.
        Vec3d landing = new Vec3d(x, Math.floor(feet.y), z);
        double width = player.getWidth() * 0.5 - 0.025;
        double sx = dz / range * width, sz = -dx / range * width;
        if (tried.contains(cell) || feet.y - landing.y > 0.28 || range > 1.45
                || !water(sample(landing.add(0, 0.10, 0))) || sample(landing.add(0, 1.67, 0)) != AIR
                || !water(sample(landing.add(sx, 0.10, sz))) || !water(sample(landing.add(-sx, 0.10, -sz)))
                || !water(sample(new Vec3d(feet.x + dx * 0.62, landing.y + 0.10, feet.z + dz * 0.62)))
                || !body.wetEscapeSweep(landing, 0, 0, 0)) return null;
        return new Lane(landing, null, null, false, 45 * (dx * driftX + dz * driftZ) / range - range * 0.21 - 0.85);
    }

    private void startDrive(int now, Lane lane) {
        phase = Phase.DRIVE;
        entered = gainAt = proofAt = now;
        actionAt = lipAt = 0;
        target = lane;
        tried.add(BlockPos.ofFloored(lane.landing()));
        originalDistance = bestDistance = distance(player.getPos(), lane.landing());
        attempts++;
        drives++;
        status = "water recovery: " + (lane.bank() ? "swimming to a witnessed bank" : "crossing to a witnessed air pocket")
            + " at " + BlockPos.ofFloored(lane.landing()).toShortString();
    }

    private void drive(int now) {
        Vec3d feet = player.getPos(), landing = target.landing();
        double remaining = distance(feet, landing), rise = landing.y - feet.y;
        boolean floating = target.floor() == null;
        if (remaining < bestDistance - 0.075) {
            gainAt = now;
            bestDistance = remaining;
        }
        if (remaining < (target.bank() ? 0.13 : 0.29) && originalDistance - remaining >= 0.37) {
            beginScan(now, "reached the witnessed refuge but still wet; looking for dry footing");
            return;
        }
        if (now - entered >= DRIVE_TICKS + (lipAt == 0 ? 0 : LIP_TICKS)
                || lipAt != 0 && now - Math.max(lipAt, gainAt) >= LIP_TICKS
                || lipAt == 0 && actionAt != 0 && now - Math.max(actionAt, gainAt) >= NO_GAIN_TICKS) {
            beginScan(now, lipAt != 0 ? "could not climb the witnessed lip; checking another line"
                : "no useful gain toward that refuge; checking another line");
            return;
        }
        float yaw = yaw(feet, landing);
        float pitch = (float) Math.toDegrees(Math.atan2(player.getEyeY() - landing.y - 0.82, remaining));
        body.turn(yaw, pitch);
        if (!body.renderedDirection(yaw, pitch, 15)) return;
        AgentBody.WetEscapeMedium head = body.wetEscapeMedium(landing.add(0, 1.67, 0));
        AgentBody.WetEscapeMedium low = body.wetEscapeMedium(landing.add(0, floating ? 0.10 : 0.067, 0));
        if (head != UNSEEN && head != AIR || low == SOLID || rise > 1.04
                || !target.bank() && Math.abs(rise) > 0.28
                || target.bank() && water(low)
                || !floating && world.getBlockState(target.floor()) != target.support()) {
            beginScan(now, "the intended air or clearance changed");
            return;
        }
        if (head == AIR && open(low)) {
            if (floating) {
                if (water(low)) proofAt = now;
            } else {
                BlockHitResult floor = body.wetEscapeFloor(landing.add(0, -0.021, 0));
                if (floor != null && target.floor().equals(floor.getBlockPos()) && safeSupport.test(floor)) proofAt = now;
            }
        }
        // A lip touching the body can move its own low/high samples out of frame.
        // This extends only the original visible lane, while its exact floor and
        // current mechanical body sweep still agree. Never extends a floating guess.
        boolean approach = target.bank() && remaining <= 1.17 && rise >= -0.14;
        if (now - proofAt > 12 && !approach) return;
        // Cross-flow is measured from neutral motion. Clip the short drift check near walls:
        // a real touch there is not permission to steer outside the witnessed lane.
        double magnitude = Math.hypot(driftX, driftZ);
        double scale = magnitude > 0 ? Math.min(2.0, 0.085 / magnitude) : 0;
        boolean lift = approach && rise >= -0.035 && body.wetEscapeRise(rise);
        if (lift) {
            if (lipAt == 0) {
                lipAt = now;
                status = "water recovery: rising at the witnessed bank lip before crossing";
            }
            body.jump();
        }
        // Check the actual pose, not an imaginary feet position on top of the bank.
        // An earlier prospective sweep authorizes a jump, not forward into the riser.
        if (!body.wetEscapeSweep(landing, 0, driftX * scale, driftZ * scale)) return;
        if (actionAt == 0) actionAt = now;
        body.driveWetEscape(lift);
    }

    private Plug findPlug(Vec3d feet, BlockPos base) {
        if (!allowEdits || hands.count(FILL) == 0) return null;
        for (int dy = 0; dy <= 1; dy++) {
            BlockPos cell = base.up(dy);
            Vec3d water = Vec3d.ofCenter(cell, 0.095);
            double dx = water.x - feet.x, dz = water.z - feet.z;
            double range = Math.hypot(dx, dz);
            if (range < 0.85 || range > 2.22 || sample(water) != FLOW || !safePlugCell(cell)) continue;
            // A neutral drift away from this wet cell or a witnessed downhill water surface
            // supports treating it as an inlet instead of blindly damming a downstream outlet.
            Vec3d below = new Vec3d(feet.x + dx * 0.43, Math.floor(feet.y) + 0.095, feet.z + dz * 0.43);
            if (!water(sample(below))) continue;
            var world = client.world;
            BlockPos wet = BlockPos.ofFloored(below);
            if (cell.equals(wet) || (dx * driftX + dz * driftZ) / range > -0.006
                    && cell.getY() + world.getFluidState(cell).getHeight(world, cell)
                        < wet.getY() + world.getFluidState(wet).getHeight(world, wet) + 0.055) continue;
            for (Direction side : PLUG_FACES) {
                BlockPos attach = cell.offset(side);
                BlockHitResult hit = body.terrainThroughWater(Vec3d.ofCenter(attach), 4.1).orElse(null);
                if (hit == null || !hit.getBlockPos().equals(attach) || hit.getSide() != side.getOpposite()
                        || !safeSupport.test(hit)) continue;
                var state = world.getBlockState(attach);
                if (state.isIn(BlockTags.BASE_STONE_OVERWORLD) || state.isOf(Blocks.COBBLESTONE)
                        || state.isOf(Blocks.COBBLED_DEEPSLATE) || state.isOf(Blocks.DIRT))
                    return new Plug(cell, water, hit);
            }
        }
        return null;
    }

    private boolean safePlugCell(BlockPos cell) {
        Vec3d velocity = player.getVelocity();
        Vec3d feet = player.getPos();
        if (protectedBlock.test(cell) || body.macroLavaNear()
                // Do not narrow the breathing opening or dam beside eyes at water level.
                || player.isSubmergedInWater() || player.getAir() < 230 || cell.getY() + 1 > player.getEyeY() - 0.30
                || Math.abs(cell.getY() - feet.y) > 1.35 || velocity.horizontalLengthSquared() > 0.0121
                || player.getBoundingBox().stretch(velocity.x * 3, 0.18, velocity.z * 3)
                    .expand(0.09, 0, 0.09).intersects(new Box(cell))) return false;
        return !standingColumn(cell, recentDry) && !standingColumn(cell, olderDry);
    }

    private static boolean standingColumn(BlockPos cell, Vec3d footing) {
        if (footing == null) return false;
        BlockPos foot = BlockPos.ofFloored(footing);
        return cell.equals(foot) || cell.equals(foot.up()) || cell.equals(foot.down());
    }

    private void place(int now) {
        if (now - entered >= 42 || !safePlugCell(plug.cell())) {
            beginScan(now, "the proposed flow cut-off could not be placed safely");
            return;
        }
        BlockHitResult face = plug.attachment();
        body.aimContact(face, AgentBody.Contact.PRECISE);
        if (body.wetEscapeMedium(plug.water()) != FLOW) return;
        var readiness = AgentBody.Preparation.equipment(hands.equipForUse(FILL));
        if (readiness == AgentBody.Preparation.READY && player.getMainHandStack().getItem() instanceof BlockItem item) {
            itemBefore = hands.count(FILL);
            placedBlock = item.getBlock();
        }
        if (body.useContact(face, AgentBody.Contact.PRECISE, readiness)) {
            useIssued = true;
            phase = Phase.DRAIN;
            entered = now;
            status = "water recovery: waiting for the placed block and actual drainage";
        }
    }

    private void drain(int now) {
        if (useIssued && body.wetEscapeMedium(plug.water()) == SOLID
                && client.world.getBlockState(plug.cell()).isOf(placedBlock) && hands.count(FILL) < itemBefore) {
            useIssued = false;
            confirmedPlug = true;
            status = "water recovery: confirmed the flow cut-off; checking whether the footing dries";
        }
        if (now - entered < 49) return;
        if (confirmedPlug) {
            phase = Phase.UNPLUG;
            entered = now;
            status = "water recovery: water remains; checking if the owned cut-off can be safely removed";
        } else beginScan(now, "no confirmed flow cut-off; checking newly visible exits");
    }

    private void unplug(int now) {
        if (undoFinished || now - entered >= 54) {
            beginScan(now, undoFinished ? "removed the ineffective owned cut-off; checking the reopened passage"
                : "could not safely remove the ineffective owned cut-off; checking remaining exits");
            return;
        }
        BlockPos cell = plug.cell();
        if (!safePlugCell(cell)) return;
        Vec3d point = Vec3d.ofCenter(cell);
        BlockHitResult hit = body.terrainThroughWater(point, 3.6).orElse(null);
        if (hit == null || !hit.getBlockPos().equals(cell)) {
            body.aimFine(point);
            return;
        }
        // Only our confirmed dirt, not the natural bank or a target guessed behind it.
        // Vanilla mine contact rechecks the supporting footprint and the actual hit.
        if (world.getBlockState(cell).isOf(placedBlock)) {
            body.aimContact(hit, AgentBody.Contact.MINE);
            body.mine(hit);
        }
    }

    private Result block(int now, String reason) {
        body.pauseWork();
        if (checkedInputs) body.holdWetEscape();
        phase = Phase.BLOCKED;
        blockedAt = player.getPos();
        entered = now;
        status = "water recovery blocked/waiting for changed evidence: " + reason;
        return Result.BLOCKED;
    }

    private Result reconsider(int now) {
        if (now - entered < RECHECK_TICKS || !body.hasRecentView()) return Result.BLOCKED;
        entered = now;
        Vec3d feet = player.getPos();
        boolean changed = !sawFrame || distance(feet, blockedAt) >= 0.61 || Math.abs(feet.y - blockedAt.y) >= 0.76;
        for (int i = 0; !changed && i < evidenceCount; i++) {
            Sight previous = localEvidence[i];
            AgentBody.WetEscapeMedium seen = body.wetEscapeMedium(previous.point());
            changed = seen != UNSEEN && seen != previous.medium();
        }
        if (!changed) return Result.BLOCKED;
        tried.clear();
        drives = 0;
        began = now;
        if (checkedInputs) {
            body.holdWetEscape();
            beginScan(now, "rechecking alternate refuges after a change in the water corridor");
        } else beginDrift(now);
        return Result.WORKING;
    }

    private AgentBody.WetEscapeMedium sample(Vec3d point) {
        AgentBody.WetEscapeMedium seen = body.wetEscapeMedium(point);
        if (seen != UNSEEN) {
            for (int i = 0; i < evidenceCount; i++)
                if (point.squaredDistanceTo(localEvidence[i].point()) < 0.012) return seen;
            if (evidenceCount < localEvidence.length) localEvidence[evidenceCount++] = new Sight(point, seen);
        }
        return seen;
    }

    private boolean dryGround() {
        return player.isOnGround() && !player.isTouchingWater() && !player.isInLava()
            && !player.isOnFire() && !player.hasVehicle();
    }

    private static boolean water(AgentBody.WetEscapeMedium medium) {
        return medium == STILL_WATER || medium == FLOW;
    }

    private static boolean open(AgentBody.WetEscapeMedium medium) {
        return medium == AIR || water(medium);
    }

    private static double distance(Vec3d a, Vec3d b) {
        return Math.hypot(a.x - b.x, a.z - b.z);
    }

    private static float yaw(Vec3d from, Vec3d to) {
        return MathHelper.wrapDegrees((float) Math.toDegrees(Math.atan2(from.x - to.x, to.z - from.z)));
    }
}
