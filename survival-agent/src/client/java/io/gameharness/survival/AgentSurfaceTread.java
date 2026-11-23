package io.gameharness.survival;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.EntityPose;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One verified cardinal dry tread, shared by ground travel and reversal of that exact edge. */
final class AgentSurfaceTread {
    private static final int PROOF_TICKS = 65;
    private static final int DRIVE_TICKS = 54;
    private static final int DROP_PEEK_TICKS = 18;
    private static final int DROP_DRIVE_TICKS = 30;
    static final int ORDINARY_GRADE_TICKS = DRIVE_TICKS + 2;
    // Includes the successful boundary ticks and a fresh post-landing frame.
    static final int ACTION_TICKS = PROOF_TICKS + DRIVE_TICKS + 4;
    record Edge(BlockPos upper, BlockState upperSupport, BlockPos lower, BlockState lowerSupport, Direction down) {}
    enum Result { CHECKING, MOVING, LANDED, REFUSED }
    enum ReturnClearance { CLEAR, DAMP, OVERHEAD, OBSTRUCTION }
    enum RecallPolicy { ISOLATED, ORDINARY }

    /** A freshly witnessed level/rising crown edge, not a reversal of a retained tread. */
    static final class CrownCrossing {
        final BlockPos from, to;
        private final Direction bearing;
        private final BlockPos takeoffBlock, landingBlock;
        final BlockState landing;
        private final BlockState takeoff;
        private final boolean rising;
        private final AgentOrdinaryNavigator.EdgeTravel travel = new AgentOrdinaryNavigator.EdgeTravel();
        private boolean advancing, airborne;
        private String refusal;

        CrownCrossing(BlockPos from, BlockPos to, Direction bearing, BlockState takeoff, BlockState landing,
                      int action, int tick) {
            this.from = from;
            this.to = to;
            this.bearing = bearing;
            this.takeoff = takeoff;
            this.landing = landing;
            takeoffBlock = from.down();
            landingBlock = to.down();
            rising = to.getY() > from.getY();
            travel.begin(action, tick);
        }

        boolean inFlight() { return advancing; }
        String refusal() { return refusal; }

        Result step(MinecraftClient client, AgentBody body, int tick) {
            var player = client.player;
            if (!body.ordinaryRouteInputs() || !body.supplyTopUnchanged(takeoffBlock, takeoff)
                    || !body.supplyTopUnchanged(landingBlock, landing))
                return refuse("the ordinary controls or an exact crown support changed");
            boolean atTakeoff = body.ordinaryRoutePhysicalContact(from);
            boolean atLanding = body.ordinaryRoutePhysicalContact(to);
            var state = observe(body.actionTick(), tick, player.getPos(), player.isOnGround(), atTakeoff, atLanding,
                player.getVelocity().horizontalLengthSquared());
            if (state == Result.LANDED || state == Result.REFUSED || !body.hasRecentView()) return state;
            if (body.ordinaryRouteLane(from, to) != AgentBody.DryRouteVeto.CLEAR)
                return refuse("the ordinary crown lane is obstructed");
            // The ordinary motor checks the actual launch volume and couples the
            // forward and jump keys at final arbitration. Keep one travel view.
            var motor = body.driveOrdinaryRoute(from, to, bearing, false, advancing);
            if (motor != AgentBody.OrdinaryMotor.VETO)
                body.turn(bearing.getPositiveHorizontalDegrees(), rising ? 19 : 31);
            return accept(motor, player.getPos());
        }

        Result observe(int action, int tick, Vec3d feet, boolean grounded, boolean atTakeoff, boolean atLanding,
                       double speedSquared) {
            if (!travel.keepTurn(action) || advancing && !travel.observe(feet))
                return refuse("the body lost the continuous crown crossing");
            if (!advancing && !atTakeoff) return refuse("the body lost the exact crown takeoff contact");
            double along = (feet.x - from.getX() - 0.5) * bearing.getOffsetX()
                + (feet.z - from.getZ() - 0.5) * bearing.getOffsetZ();
            if (advancing && atLanding && AgentBody.dryStrideContact(1 - along)
                    && speedSquared <= 0.0036 && travel.traversed()) return Result.LANDED;
            if (rising && advancing) {
                if (airborne && grounded && feet.y < to.getY() - 0.055)
                    return refuse("the jump did not reach its witnessed crown top");
                airborne |= !grounded;
            }
            if (travel.expired(tick, along)) return refuse("the body did not advance along the checked crown tread");
            return advancing ? Result.MOVING : Result.CHECKING;
        }

        Result accept(AgentBody.OrdinaryMotor motor, Vec3d feet) {
            if (motor == AgentBody.OrdinaryMotor.VETO) return refuse("the ordinary body sweep vetoed the crown tread");
            if (!advancing && motor == AgentBody.OrdinaryMotor.KEY) {
                travel.startMotion(feet);
                advancing = true;
            }
            return advancing ? Result.MOVING : Result.CHECKING;
        }

        private Result refuse(String why) {
            refusal = why;
            return Result.REFUSED;
        }
    }

    /** The canopy-only, budgeted branch; it cannot construct an ordinary or reversible edge. */
    static final class MeasuredDescent {
        private static final int PROOF_TICKS = 38, MOTION_TICKS = 45, RECEIPT_TICKS = 8;
        private final AgentDryLanding.Measured drop;
        private final long started;
        private long driving = -1, contactSince = -1;
        private int motorTick;
        private Vec3d previous;
        private float observedHealth, damageTaken;
        private String refusal;
        private boolean committed, airborne;

        MeasuredDescent(AgentDryLanding.Measured drop, long tick) {
            this.drop = drop;
            started = tick;
        }

        boolean inFlight() { return driving >= 0; }
        String refusal() { return refusal; }
        float damageTaken() { return damageTaken; }

        boolean landingContact(MinecraftClient client, AgentBody body) {
            return inFlight() && airborne && body.measuredLandingContact(drop);
        }

        boolean controlsFall(MinecraftClient client, AgentBody body, long tick) {
            return inFlight() && !client.player.isOnGround() && tick - driving < MOTION_TICKS
                && motorTick + 1 == body.actionTick() && body.measuredFallCoast(drop);
        }

        Result step(MinecraftClient client, AgentBody body, long tick) {
            var player = client.player;
            if (!inFlight() && tick - started > PROOF_TICKS)
                return refuse("the measured takeoff lost its rendered top or settled alignment");
            if (inFlight()) {
                float health = player.getHealth();
                damageTaken += Math.max(0, observedHealth - health);
                observedHealth = health;
                if (damageTaken > drop.damage()) return refuse("observed HP loss exceeded the measured descent budget");
                if (tick - driving >= MOTION_TICKS) return refuse("the measured descent failed to settle on its witnessed top");
                Vec3d feet = player.getPos();
                boolean contact = landingContact(client, body);
                double dy = feet.y - previous.y, dx = feet.x - previous.x, dz = feet.z - previous.z;
                int elapsed = body.actionTick() - motorTick;
                if ((elapsed != 1 && !(contact && elapsed > 0 && elapsed <= 3))
                        || (contactSince < 0 && (dy > 1e-5 || dy < -1.4 || dx * dx + dz * dz > 0.30 * 0.30)))
                    return refuse("the measured descent lost its contiguous vanilla body movement");
                previous = feet;
                motorTick = body.actionTick();
                if (contact) {
                    if (contactSince < 0) contactSince = tick;
                    // Touchdown may itself cause hurtTime. Finish from exact body contact
                    // and the actual client health updates, with no extra movement key.
                    return tick - contactSince >= RECEIPT_TICKS && player.getVelocity().horizontalLengthSquared() <= 0.0001
                        ? Result.LANDED : Result.MOVING;
                }
                if (contactSince >= 0 || airborne && player.isOnGround())
                    return refuse("the measured descent lost its exact landing support");
                if (!player.isOnGround()) airborne = committed = true;
                if (committed) return body.measuredFallCoast(drop) ? Result.MOVING
                    : refuse("changed support, threat, or body path vetoed the measured coast");
            }
            var motor = body.driveMeasuredDrop(drop);
            if (motor == AgentBody.OrdinaryMotor.VETO)
                return refuse("health, hunger, danger, changed support, or the stopping envelope vetoed the measured takeoff");
            if (motor == AgentBody.OrdinaryMotor.ALIGN) return inFlight() ? Result.MOVING : Result.CHECKING;
            if (!inFlight()) {
                driving = tick;
                previous = player.getPos();
                observedHealth = player.getHealth();
                motorTick = body.actionTick();
            }
            if (motor == AgentBody.OrdinaryMotor.COAST) committed = true;
            return Result.MOVING;
        }

        private Result refuse(String why) {
            refusal = why;
            return Result.REFUSED;
        }
    }

    final Edge edge;
    final boolean returning;
    final BlockPos from, to;
    private final Direction travel;
    private final Vec3d center, floorAim, nearFloorAim, chestAim, headAim;
    private final BlockPos sourceSupport, landingSupport;
    private final RecallPolicy recallPolicy;
    private final boolean witnessedOutbound, ordinaryGrade, stockAccess;
    private final AgentDryCaveRoute.Probe levelProbe;
    private final AgentWalkedRoute.Motion motion = new AgentWalkedRoute.Motion();
    private final long started;
    private long drivingSince = -1;
    private boolean floorSeen, chestSeen, headSeen;
    private String refusal;
    private ReturnClearance returnRefusal = ReturnClearance.CLEAR;
    private AgentSurfaceTread ahead;
    private AgentDryLanding drop;
    private int dropMotorTick;
    private String dropProof;

    AgentSurfaceTread(Edge edge, boolean returning, long started) {
        this(edge, returning, started, null, false, false, false);
    }

    /** The ordinary prospect just re-witnessed this landing and both passage samples. */
    static AgentSurfaceTread witnessedOutbound(Edge edge, long tick) {
        return new AgentSurfaceTread(edge, false, tick, null, true, false, false);
    }

    static boolean ordinaryRiseSide(BlockPos from, Direction travel, BlockHitResult hit) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && travel.getAxis().isHorizontal() && hit.getSide() == travel.getOpposite()
            && hit.getBlockPos().equals(from.offset(travel));
    }

    /** The caller supplies a freshly lit, full stable top and a mechanically cleared sweep. */
    static Edge witnessedGradeEdge(BlockPos from, BlockState source, Direction travel, BlockHitResult hit,
                                   BlockState landing, boolean clearance) {
        if (!clearance || hit == null || hit.isInsideBlock() || source == null || landing == null
                || AgentBody.dryCaveDanger(source) || AgentBody.dryCaveDanger(landing)) return null;
        BlockPos floor = hit.getBlockPos(), to = floor.up();
        int grade = to.getY() - from.getY();
        if (Math.abs(grade) != 1 || !cardinalTread(from, to, travel) || !AgentBody.matchesDryRouteTop(hit, floor))
            return null;
        return grade > 0 ? new Edge(to, landing, from, source, travel.getOpposite())
            : new Edge(from, source, to, landing, travel);
    }

    static AgentSurfaceTread ordinaryGrade(Edge edge, BlockPos from, long tick) {
        return new AgentSurfaceTread(edge, edge.lower.equals(from), tick, null, true, true, false);
    }

    /** Ordinary stock/supply work may collect; it still uses the same checked level/grade motor. */
    static AgentSurfaceTread ordinaryStock(Edge edge, BlockPos from, long tick) {
        return new AgentSurfaceTread(edge, !edge.upper.equals(from), tick, null, true,
            edge.upper.getY() != edge.lower.getY(), true);
    }

    private AgentSurfaceTread(Edge edge, boolean returning, long started, RecallPolicy recallPolicy,
                              boolean witnessedOutbound, boolean ordinaryGrade, boolean stockAccess) {
        this.edge = edge;
        this.returning = returning;
        this.started = started;
        this.recallPolicy = recallPolicy;
        this.witnessedOutbound = witnessedOutbound;
        this.ordinaryGrade = ordinaryGrade;
        this.stockAccess = stockAccess;
        from = returning ? edge.lower : edge.upper;
        to = returning ? edge.upper : edge.lower;
        travel = returning ? edge.down.getOpposite() : edge.down;
        sourceSupport = from.down();
        landingSupport = to.down();
        center = Vec3d.ofBottomCenter(to);
        floorAim = ordinaryDescent() ? AgentDryLanding.caveTopAim(from, travel, from.getY() - to.getY())
            : center.add(0.28 * travel.getOffsetX(), -0.032, 0.28 * travel.getOffsetZ());
        nearFloorAim = ordinaryDescent() ? AgentDryLanding.caveTopAim(from, travel, from.getY() - to.getY(), true)
            : center.add(-0.22 * travel.getOffsetX(), -0.032, -0.22 * travel.getOffsetZ());
        chestAim = center.add(0.07 * travel.getOffsetX(), 1.32, 0.07 * travel.getOffsetZ());
        headAim = isolated() ? center.add(0.12 * travel.getOffsetX(), 1.76, 0.12 * travel.getOffsetZ()) : chestAim;
        levelProbe = from.getY() == to.getY() && !witnessedOutbound
            ? new AgentDryCaveRoute.Probe(from, to, travel) : null;
    }

    /** The constrained recall remains pickup-free and reverse-proved. */
    static AgentSurfaceTread recall(MinecraftClient client, BlockPos from, BlockPos to, long tick) {
        return recall(client, from, to, tick, RecallPolicy.ISOLATED);
    }

    static AgentSurfaceTread ordinaryRecall(MinecraftClient client, BlockPos from, BlockPos to, long tick) {
        return recall(client, from, to, tick, RecallPolicy.ORDINARY);
    }

    private static Direction recallBearing(BlockPos from, BlockPos to) {
        int dx = to.getX() - from.getX(), dz = to.getZ() - from.getZ();
        return dx == 0 ? dz > 0 ? Direction.SOUTH : Direction.NORTH : dx > 0 ? Direction.EAST : Direction.WEST;
    }

    private static boolean recallGeometry(BlockPos from, BlockPos to, Direction travel, RecallPolicy policy) {
        return cardinalTread(from, to, travel)
            || policy == RecallPolicy.ORDINARY && AgentDryLanding.shape(from, to, travel);
    }

    static boolean ordinaryRecallGeometry(BlockPos from, BlockPos to) {
        return recallGeometry(from, to, recallBearing(from, to), RecallPolicy.ORDINARY);
    }

    private static AgentSurfaceTread recall(MinecraftClient client, BlockPos from, BlockPos to, long tick,
                                            RecallPolicy policy) {
        Direction travel = recallBearing(from, to);
        boolean up = to.getY() > from.getY();
        if (!recallGeometry(from, to, travel, policy) || client.options.forwardKey.isUnbound()
                || up && client.options.jumpKey.isUnbound()) return null;
        BlockPos upper = up ? to : from, lower = up ? from : to;
        var edge = new Edge(upper, client.world.getBlockState(upper.down()),
            lower, client.world.getBlockState(lower.down()), up ? travel.getOpposite() : travel);
        return recall(edge, up, tick, policy);
    }

    static AgentSurfaceTread recall(Edge edge, boolean up, long tick, RecallPolicy policy) {
        if (!(up ? cardinalTread(edge.upper, edge.lower, edge.down)
                : recallGeometry(edge.upper, edge.lower, edge.down, policy))) return null;
        return new AgentSurfaceTread(edge, up, tick, policy, false, false, false);
    }

    private boolean isolated() { return recallPolicy == RecallPolicy.ISOLATED; }
    boolean requiresPickupFreeSweep() { return isolated() || ordinaryGrade && !stockAccess; }
    boolean ordinaryDescent() { return recallPolicy == RecallPolicy.ORDINARY && to.getY() < from.getY(); }
    boolean inFlight() { return drivingSince >= 0; }

    boolean leftTakeoff(MinecraftClient client) {
        var player = client.player;
        return drop != null && inFlight() && (!player.isOnGround() || player.getY() < from.getY() - 0.055
            || !drop.overlapsLip(player.getPos(), player.getWidth() * 0.5));
    }

    boolean controlsShortFall(MinecraftClient client, AgentBody body, long tick) {
        var player = client.player;
        return drop != null && inFlight() && !player.isOnGround() && dropMotorTick + 1 == body.actionTick()
            && tick - drivingSince < DROP_DRIVE_TICKS && body.caveDryLandingRefusal(drop) == null;
    }

    boolean refusedOnTakeoff(BlockPos foot, boolean grounded) {
        return !returning && grounded && from.equals(foot);
    }

    /** Look ahead only along the next exact walked level edge, never around a corner or over a riser. */
    AgentSurfaceTread recallSuccessor(MinecraftClient client, BlockPos next, long tick) {
        if (!isolated() || !straightLevelContinuation(from, to, next, travel)) return null;
        if (ahead == null || !ahead.to.equals(next)) ahead = recall(client, to, next, tick);
        return ahead;
    }

    boolean rememberedLaneChanged(MinecraftClient client, AgentBody body) {
        return !body.walkedLaneDry(from, to, travel) || !retainedLaneClear(client, from, to, travel)
            || client.world.getBlockState(sourceSupport) != (returning ? edge.lowerSupport : edge.upperSupport)
            || client.world.getBlockState(landingSupport) != (returning ? edge.upperSupport : edge.lowerSupport);
    }

    static BlockPos nextFoot(BlockPos foot, Direction down) {
        return foot.offset(down).down();
    }

    static long returnTicks(int edges) { return (long) edges * ACTION_TICKS; }

    static boolean canExtend(long ticksLeft, int retainedEdges) {
        return ticksLeft > ACTION_TICKS + returnTicks(retainedEdges + 1);
    }

    static boolean plannedCell(BlockPos foot, BlockPos cell, Direction down, Direction face) {
        if (down == null || !down.getAxis().isHorizontal()) return false;
        BlockPos next = nextFoot(foot, down);
        return cell.equals(next.up()) && face == down.getOpposite() || cell.equals(next) && face == Direction.UP;
    }

    /** Rebind only a positively confirmed standing contact, not the far landing or an unknown replacement floor. */
    static Edge rebindSoilContact(Edge edge, BlockPos occupied, BlockState contact) {
        if (edge.lower.equals(occupied) && edge.lower.equals(nextFoot(edge.upper, edge.down))
                && surfaceSoilChange(edge.lowerSupport, contact))
            return new Edge(edge.upper, edge.upperSupport, edge.lower, contact, edge.down);
        return edge;
    }

    /** The returning camera must have positively witnessed the exact stable dry top. */
    static Edge rebindSoilLanding(Edge edge, BlockHitResult top, BlockState witnessed) {
        if (top != null && !top.isInsideBlock() && AgentBody.matchesDryRouteTop(top, edge.upper.down())
                && surfaceSoilChange(edge.upperSupport, witnessed))
            return new Edge(edge.upper, witnessed, edge.lower, edge.lowerSupport, edge.down);
        return edge;
    }

    private static boolean surfaceSoilChange(BlockState before, BlockState after) {
        return after != null && (before.isOf(Blocks.DIRT) && after.isOf(Blocks.GRASS_BLOCK)
            || before.isOf(Blocks.GRASS_BLOCK) && after.isOf(Blocks.DIRT));
    }

    static boolean returnLip(BlockPos foot, BlockPos cell, Direction down, Direction face) {
        return down != null && down.getAxis().isHorizontal() && face == down.getOpposite()
            && cell.equals(nextFoot(foot, down).up(2));
    }

    /** The exact two-column clearance envelope of a descending tread and its reverse jump. */
    static boolean prospectCell(BlockPos foot, BlockPos cell, Direction down) {
        if (down == null || !down.getAxis().isHorizontal()) return false;
        int dy = cell.getY() - foot.getY();
        return cell.equals(foot.up(2)) || dy >= -1 && dy <= 2 && cell.equals(foot.offset(down).up(dy));
    }

    /** A level leg can cut only its next foot and head cell, never a floor or ceiling. */
    static boolean prospectLevelCell(BlockPos foot, BlockPos cell, Direction travel) {
        return travel != null && travel == prospectLevelBearing(foot, cell);
    }

    static Direction prospectLevelBearing(BlockPos foot, BlockPos cell) {
        int dy = cell.getY() - foot.getY();
        if (dy != 0 && dy != 1) return null;
        int dx = cell.getX() - foot.getX(), dz = cell.getZ() - foot.getZ();
        if (dz == 0) return dx == 1 ? Direction.EAST : dx == -1 ? Direction.WEST : null;
        if (dx == 0) return dz == 1 ? Direction.SOUTH : dz == -1 ? Direction.NORTH : null;
        return null;
    }

    static boolean cardinalTread(BlockPos from, BlockPos to, Direction travel) {
        return travel.getAxis().isHorizontal() && Math.abs(to.getY() - from.getY()) <= 1
            && to.getX() - from.getX() == travel.getOffsetX() && to.getZ() - from.getZ() == travel.getOffsetZ();
    }

    static boolean straightLevelContinuation(BlockPos from, BlockPos to, BlockPos next, Direction travel) {
        return from.getY() == to.getY() && to.getY() == next.getY()
            && cardinalTread(from, to, travel) && cardinalTread(to, next, travel);
    }

    /** A seen floor is expendable only while a different usable exit or a walked return survives. */
    static int spareLevelFloorChoices(int candidates, int usableExits, boolean walkedReturn) {
        if (walkedReturn || Integer.bitCount(usableExits) > 1) return candidates;
        return usableExits == 0 ? 0 : candidates & ~usableExits;
    }

    /** Recheck known terrain before cutting; this cannot supply a new route witness. */
    static boolean retainedLaneClear(MinecraftClient client, BlockPos from, BlockPos to, Direction travel) {
        if (!cardinalTread(from, to, travel) || !reverseClear(client, from, to, travel)) return false;
        if (from.getY() != to.getY()) {
            BlockPos lower = from.getY() < to.getY() ? from : to;
            if (!client.world.getBlockState(lower).getCollisionShape(client.world, lower).isEmpty()) return false;
        }
        return client.world.isSpaceEmpty(client.player, retainedTreadSweep(from, to, client.player.getWidth()));
    }

    static Box retainedTreadSweep(BlockPos from, BlockPos to, double width) {
        double half = width * 0.5 + 0.055;
        double y = Math.max(from.getY(), to.getY());
        return new Box(Math.min(from.getX(), to.getX()) + 0.5 - half, y + 0.015,
            Math.min(from.getZ(), to.getZ()) + 0.5 - half, Math.max(from.getX(), to.getX()) + 0.5 + half,
            y + 1.80, Math.max(from.getZ(), to.getZ()) + 0.5 + half);
    }

    /** Aim just inside the opening: farther top samples can hit the near roof before crossing the lip. */
    static Vec3d innerTop(BlockPos cell, Direction down) {
        return Vec3d.ofBottomCenter(cell.up()).add(0.12 * down.getOffsetX(), -0.035, 0.12 * down.getOffsetZ());
    }

    Result step(MinecraftClient client, AgentBody body, long tick) {
        return step(client, body, tick, null);
    }

    Result step(MinecraftClient client, AgentBody body, long tick, AgentSurfaceTread successor) {
        var player = client.player;
        String support = supportRefusal(client, body);
        if (support != null) return refuse(support);
        if (ordinaryDescent()) return stepOrdinaryDescent(client, body, tick);
        if (drivingSince >= 0 && !motion.observe(player.getX(), player.getY(), player.getZ()))
            return refuse("The body drifted off the exact dry tread.");
        if (drivingSince < 0 && tick - started > PROOF_TICKS) {
            if (recallPolicy == RecallPolicy.ORDINARY)
                return refuse(levelProbe != null ? "Level tread proof expired: " + levelProbe.evidence()
                    : !floorSeen ? "The rising tread's exact floor was not witnessed."
                    : "The rising tread's chest clearance was not witnessed.");
            return refuse("The dry landing or passage could not be witnessed within the tread's view window.");
        }
        if (drivingSince >= 0 && tick - drivingSince > DRIVE_TICKS)
            return refuse("The body did not ground on the dry landing within the tread's movement window.");
        if (!body.hasRecentView()) return drivingSince < 0 ? Result.CHECKING : Result.MOVING;
        if (requiresPickupFreeSweep() && !body.macroNoVisiblePickup(center, Math.min(from.getY(), to.getY()),
                Math.max(from.getY(), to.getY()) + 0.32)) return refuse("The dry tread no longer has a pickup-free sweep.");
        if (drivingSince < 0) {
            if (!player.isOnGround() || !player.getBlockPos().equals(from))
                return refuse("The body is not grounded on the exact dry takeoff tread.");
            if (recallPolicy == RecallPolicy.ORDINARY && (body.dryCaveContact(from) != sourceState()
                    || !sourceSupport.equals(player.supportingBlockPos.orElse(null))))
                return refuse("The player lacks stable vanilla contact on the exact takeoff support.");
            if (!witnessedOutbound && !centered(player.getPos(), from, 0.17)) {
                body.centerOnSupport(sourceSupport);
                return Result.CHECKING;
            }
            if (player.getVelocity().horizontalLengthSquared() > 0.0025) return Result.CHECKING;
            if (!witnessedOutbound && !sampleProof(body, null, 0)) {
                if (levelProbe != null && (levelProbe.visiblyRefused()
                        || recallPolicy != RecallPolicy.ORDINARY
                            && body.renderedDirection(travel.getPositiveHorizontalDegrees(), AgentBody.LEVEL_ROUTE_PITCH, 5)
                            && !body.dryRouteRaysSpent()))
                    return refuse(recallPolicy == RecallPolicy.ORDINARY ? "Level tread proof: " + levelProbe.evidence()
                        : "The current view does not verify the exact level tread's floor and passage.");
                lookThroughOpening(body, player.getEyePos(), tick);
                return Result.CHECKING;
            }
        }
        boolean level = from.getY() == to.getY();
        if (player.getY() < Math.min(from.getY(), to.getY()) - 0.055)
            return refuse("The body is below the lowest verified dry tread.");
        ReturnClearance reverse = level ? ReturnClearance.CLEAR : reverseClearance(client, edge.upper, edge.lower, edge.down);
        var ordinaryVeto = recallPolicy == RecallPolicy.ORDINARY && reverse == ReturnClearance.CLEAR
            ? body.dryRouteVeto(from, to) : null;
        if (reverse != ReturnClearance.CLEAR
                || (ordinaryVeto != null ? ordinaryVeto != AgentBody.DryRouteVeto.CLEAR
                    : !(ordinaryGrade ? body.ordinaryGradeSweep(from, to) : body.dryRouteSweep(from, to)))) {
            if (drivingSince >= 0 && tick - drivingSince < 5) return Result.CHECKING;
            if (ordinaryVeto != null) return refuse("Live dry tread veto: " + ordinaryVeto);
            // A collision alone does not identify a block. If the ordinary body
            // lane is also unusable, don't treat this as an isolated overhead veto.
            returnRefusal = reverse == ReturnClearance.DAMP ? reverse
                : reverse == ReturnClearance.OVERHEAD && !ordinaryGrade && drivingSince < 0
                    && body.walkedLaneDry(from, to, travel) && body.dryRouteSweep(from, to) ? reverse
                : ReturnClearance.OBSTRUCTION;
            return refuse(switch (returnRefusal) {
                case DAMP -> "Fluid vetoes the retained reverse tread.";
                case OVERHEAD -> "The retained reverse jump intersects an overhead obstruction above the clear walking lane.";
                default -> recallPolicy == RecallPolicy.ORDINARY && reverse != ReturnClearance.CLEAR
                    ? "The rising tread's jump clearance is obstructed."
                    : "The live body sweep, reverse passage, or support is obstructed for the exact dry tread.";
            });
        }
        if (drivingSince < 0) beginDrive(player.getPos(), tick);
        boolean carry = successor != null && canCarry(client, body, successor, tick);
        boolean landed = player.isOnGround() && player.getBlockPos().equals(to)
            && centered(player.getPos(), to, 0.23) && Math.abs(player.getY() - to.getY()) <= 0.055;
        if (landed && recallPolicy == RecallPolicy.ORDINARY)
            landed = landingSupport.equals(player.supportingBlockPos.orElse(null)) && body.dryCaveContact(to) == landingState();
        double remaining = (center.x - player.getX()) * travel.getOffsetX() + (center.z - player.getZ()) * travel.getOffsetZ();
        if (landed && (carry && AgentBody.dryStrideContact(remaining)
                || player.getVelocity().horizontalLengthSquared() <= 0.0025)) {
            if (!motion.traversed()) return refuse("The body did not traverse the exact dry tread.");
            if (carry) {
                successor.beginDrive(player.getPos(), tick);
                body.driveDryRoute(successor.from, successor.to, successor.travel);
            }
            return Result.LANDED;
        }
        body.driveDryRoute(from, to, travel, carry);
        return Result.MOVING;
    }

    private Result stepOrdinaryDescent(MinecraftClient client, AgentBody body, long tick) {
        var player = client.player;
        if (inFlight()) {
            if (dropMotorTick + 1 != body.actionTick()
                    || !motion.observe(player.getX(), player.getY(), player.getZ()))
                return refuse("The one-way descent lost its contiguous body path.");
            dropMotorTick = body.actionTick();
            if (tick - drivingSince >= DROP_DRIVE_TICKS)
                return refuse(dropProof != null ? dropProof : "The one-way descent did not settle on the witnessed support.");
            if (leftTakeoff(client)) {
                var veto = body.caveDryLandingRefusal(drop);
                if (veto != null) return refuse(veto.detail());
                if (drop.settled(player.getPos(), player.supportingBlockPos.orElse(null), landingState(),
                        player.getVelocity().horizontalLengthSquared(), player.isOnGround())) {
                    return motion.traversed() ? Result.LANDED : refuse("The body did not traverse the witnessed descent.");
                }
                return Result.MOVING; // Never steer in the air or jump back over the lip.
            }
            var veto = body.driveCaveDryLanding(drop);
            if (veto != null && veto != AgentBody.CaveLandingRefusal.ALIGNMENT
                    && veto != AgentBody.CaveLandingRefusal.FLOOR_RECHECK) return refuse(veto.detail());
            dropProof = veto == null ? null : veto.detail();
            return Result.MOVING;
        }
        if (tick - started > PROOF_TICKS)
            return refuse(dropProof != null ? dropProof : "No settled view of the exact lower top before the look expired.");
        if (!body.hasRecentView()) return Result.CHECKING;
        if (body.caveLipFooting(from) != sourceState())
            return refuse("The takeoff lacks stable dry contact or the controls for a bounded drop.");
        if (body.hazardAhead(travel.getPositiveHorizontalDegrees(), 1.65))
            return refuse("A visible hazard vetoes the directed descent.");
        if (tick - started < DROP_PEEK_TICKS) {
            double across = (player.getX() - from.getX() - 0.5) * travel.getOffsetZ()
                - (player.getZ() - from.getZ() - 0.5) * travel.getOffsetX();
            if (Math.abs(across) > 0.14) {
                if (!body.centerOnCaveLip(from, sourceState()))
                    return refuse("The player could not center safely on the witnessed lip.");
                return Result.CHECKING;
            }
            body.turnFixed(travel.getPositiveHorizontalDegrees(), 75);
            body.driveCaveLip(from, travel);
            return Result.CHECKING;
        }
        Vec3d aim = tick - started < 38 ? floorAim : nearFloorAim;
        body.aim(aim);
        if (player.getPose() != EntityPose.STANDING || player.getVelocity().horizontalLengthSquared() > 0.0025
                || !body.renderedAim(aim, 8) || body.dryRouteRaysSpent()) return Result.CHECKING;
        int height = from.getY() - to.getY();
        var check = body.caveDryLanding(from, travel, height, sourceState(), aim);
        if (check.landing() == null) {
            dropProof = check.refusal().detail();
            return Result.CHECKING;
        }
        var landing = check.landing();
        var veto = body.driveCaveDryLanding(landing);
        if (veto != null) {
            dropProof = veto.detail();
            return Result.CHECKING;
        }
        dropProof = null;
        drop = landing;
        beginDrive(player.getPos(), tick);
        dropMotorTick = body.actionTick();
        return Result.MOVING;
    }

    private BlockState sourceState() { return returning ? edge.lowerSupport : edge.upperSupport; }
    private BlockState landingState() { return returning ? edge.upperSupport : edge.lowerSupport; }
    String refusal() { return refusal; }
    ReturnClearance returnRefusal() { return returnRefusal; }

    private Result refuse(String reason) {
        refusal = reason;
        return Result.REFUSED;
    }

    private boolean drySupport(MinecraftClient client, AgentBody body) {
        return supportRefusal(client, body) == null;
    }

    private String supportRefusal(MinecraftClient client, AgentBody body) {
        var player = client.player;
        var world = client.world;
        if (player.isTouchingWater() || player.isInLava() || player.isOnFire() || player.hasVehicle() || player.hurtTime != 0)
            return "The player's current body state is unsafe for the dry tread.";
        if (!(ordinaryDescent() ? AgentDryLanding.shape(from, to, travel) : cardinalTread(edge.upper, edge.lower, edge.down)))
            return "The retained tread no longer has cardinal geometry.";
        if (world.getBlockState(sourceSupport) != sourceState()) return "The exact takeoff support state changed.";
        if (world.getBlockState(landingSupport) != landingState()) return "The exact landing support state changed.";
        return !ordinaryDescent() && (from.getY() == to.getY() || isolated() || witnessedOutbound
                || recallPolicy == RecallPolicy.ORDINARY) && !body.walkedLaneDry(from, to, travel)
            ? "A retained dry tread column is no longer safe." : null;
    }

    private void beginDrive(Vec3d feet, long tick) {
        drivingSince = tick;
        motion.start(feet.x, feet.y, feet.z);
    }

    private boolean sampleProof(AgentBody body, BlockState arrival, int arrivalTick) {
        if (levelProbe != null) {
            int now = body.actionTick();
            var view = body.dryCaveProbeView();
            if (levelProbe.changedWitness(view) != null) levelProbe.reset();
            BlockState contact = body.dryCaveContact(from);
            levelProbe.sample(view, now, body.renderedFrame(), contact != null ? contact : arrival,
                contact != null ? now : arrivalTick);
            return levelProbe.complete(now);
        }
        if (!floorSeen) floorSeen = body.dryRouteFloor(floorAim, landingSupport) != null
            || body.dryRouteFloor(nearFloorAim, landingSupport) != null;
        if (!chestSeen) chestSeen = body.dryRouteClear(chestAim) == AgentBody.DryRouteSample.CLEAR;
        if (isolated() && !headSeen) headSeen = body.dryRouteClear(headAim) == AgentBody.DryRouteSample.CLEAR;
        return floorSeen && chestSeen && (!isolated() || headSeen);
    }

    private void lookThroughOpening(AgentBody body, Vec3d eye, long tick) {
        if (levelProbe != null) {
            body.turnFixed(travel.getPositiveHorizontalDegrees(), AgentBody.LEVEL_ROUTE_PITCH);
            return;
        }
        // Cover the landing and its opening in one rendered view. If a lip or
        // narrow FOV hides one end, favor that end once rather than aiming a checklist.
        double low = pitch(eye, floorAim);
        double high = pitch(eye, isolated() ? headAim : chestAim);
        double blend = tick - started < 18 ? 0.5 : !floorSeen ? 0.8 : 0.22;
        body.turnFixed(travel.getPositiveHorizontalDegrees(), (float) (low * blend + high * (1 - blend)));
    }

    private static double pitch(Vec3d eye, Vec3d at) {
        return Math.toDegrees(Math.atan2(eye.y - at.y, Math.hypot(at.x - eye.x, at.z - eye.z)));
    }

    private boolean canCarry(MinecraftClient client, AgentBody body, AgentSurfaceTread next, long tick) {
        return to.equals(next.from) && straightLevelContinuation(from, to, next.to, travel) && next.drivingSince < 0
            && tick - next.started <= PROOF_TICKS && landingState() == next.sourceState()
            && AgentBody.normalDryTraction(sourceState()) && next.drySupport(client, body)
            && levelProbe != null && next.sampleProof(body, levelProbe.floorState(body.actionTick()), levelProbe.floorSeenAt())
            && body.dryRouteContinuationClear(next.from, next.to, travel,
                next.sourceState(), next.landingState())
            && (!next.isolated() || body.macroNoVisiblePickup(next.center, next.from.getY(), next.to.getY() + 0.32));
    }

    /** Veto only on the two positively identified columns; never use collision to discover a tread. */
    static boolean reverseClear(MinecraftClient client, BlockPos upper, BlockPos lower, Direction travel) {
        return reverseClearance(client, upper, lower, travel) == ReturnClearance.CLEAR;
    }

    private static ReturnClearance reverseClearance(MinecraftClient client, BlockPos upper, BlockPos lower, Direction travel) {
        boolean level = upper.getY() == lower.getY();
        for (int i = 0; i <= (level ? 1 : 2); ++i) {
            if (!client.world.getBlockState(lower.up(i)).getFluidState().isEmpty()
                    || !client.world.getBlockState(upper.up(i)).getFluidState().isEmpty()) return ReturnClearance.DAMP;
        }
        if (level) return ReturnClearance.CLEAR; // The standing sweep serves both walking directions.
        return client.world.isSpaceEmpty(client.player,
            reverseJumpSweep(upper, lower, travel, client.player.getWidth())) ? ReturnClearance.CLEAR : ReturnClearance.OVERHEAD;
    }

    static Box reverseJumpSweep(BlockPos upper, BlockPos lower, Direction travel, double width) {
        return reverseJumpHeadroom(upper.withY(Math.max(upper.getY(), lower.getY())), width)
            .stretch(travel.getOffsetX(), 0, travel.getOffsetZ());
    }

    static Box reverseJumpHeadroom(BlockPos upper, double width) {
        double half = width * 0.5 + 0.055;
        double x = upper.getX() + 0.5, y = upper.getY(), z = upper.getZ() + 0.5;
        return new Box(x - half, y + 1.79, z - half, x + half, y + 2.08, z + half);
    }

    private static boolean centered(Vec3d position, BlockPos foot, double tolerance) {
        return Math.abs(position.x - foot.getX() - 0.5) <= tolerance && Math.abs(position.z - foot.getZ() - 0.5) <= tolerance;
    }
}
