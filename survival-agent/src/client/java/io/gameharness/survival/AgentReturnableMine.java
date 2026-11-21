package io.gameharness.survival;

import java.util.Arrays;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.state.property.Properties;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.BlockView;

/** A short ordinary mine job. Only its next tread is an excavation intention. */
final class AgentReturnableMine {
    private static final int LEG_LIMIT = 3;
    private static final int TORCH_RESERVE = 2;
    private static final int TOOL_RESERVE = 4;
    private static final int LEG_TICKS = 520;
    private static final int PROGRESS_LEASE_TICKS = 48;
    private static final int CAVE_TURN_LIMIT = 220;
    private static final int RETIRED_LIMIT = 32;
    private static final int RELOCATION_TICKS = 620;
    private static final int RELOCATION_HOPS = 10;
    private static final int CAP_EXIT_TICKS = 155;
    private static final int DEPARTURE_VIEW_TICKS = 38;
    private static final Direction[] CARDINALS = {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST};
    // The tallest samples cover the lower tread's jump takeoff, not just standing room.
    private static final double[] CLEARANCE_HEIGHTS = {0.20, 0.97, 1.79, 2.86};

    enum Outcome { WORKING, REACHED, FAILED, DIVERTED, EXHAUSTED, SUPPLIES }
    private enum Phase { ANCHOR, CHOOSE, OPEN, CAP_EXIT, CUT, LIGHT, FORWARD, DRIVE, REVERSE, TRIM_RETURN, RELOCATE }
    private record Refusal(BlockPos foot, Direction bearing, Face fact) {}
    enum Face { UNSEEN, NO_LANDING, NO_EXIT, DARK, OCCLUDED, FLUID, LAVA, FOOTPRINT, PROTECTED, MATERIAL, TOOL, FAILED, MINEABLE }

    /** Neighboring positions in the same worksite do not become fresh mine starts. */
    static final class Loci {
        private final BlockPos[] exhausted = new BlockPos[12];
        private int cursor;

        boolean fresh(BlockPos foot) {
            for (BlockPos old : exhausted) {
                if (old == null || Math.abs((long) foot.getY() - old.getY()) > 1) continue;
                long dx = (long) foot.getX() - old.getX(), dz = (long) foot.getZ() - old.getZ();
                if (dx * dx + dz * dz < 9) return false;
            }
            return true;
        }

        void exhausted(BlockPos foot) {
            for (BlockPos old : exhausted) if (foot.equals(old)) return;
            exhausted[cursor++ % exhausted.length] = foot.toImmutable();
        }

        void clear() {
            Arrays.fill(exhausted, null);
            cursor = 0;
        }
    }

    /** Per tread: only a confirmed edit starts the quiet window; new proofs can then renew it. */
    static final class RouteWork {
        private final long[] cuts = new long[4]; // Three descending cells and one reverse trim.
        private int cutCount, lastProgress;
        private boolean lit;

        void reset() {
            cutCount = 0;
            lit = false;
        }

        void cut(BlockPos cell, int now) {
            long packed = cell.asLong();
            for (int i = 0; i < cutCount; i++) if (cuts[i] == packed) return;
            if (cutCount == cuts.length) return;
            cuts[cutCount++] = packed;
            lastProgress = now;
        }

        void light(int now) {
            if (lit) return;
            lit = true;
            lastProgress = now;
        }

        void proved(int now) {
            if (recent(now)) lastProgress = now;
        }

        boolean recent(int now) {
            return (cutCount != 0 || lit) && now - lastProgress <= PROGRESS_LEASE_TICKS;
        }
    }

    private final MinecraftClient client;
    private final AgentBody body;
    private final Refusal[] retired = new Refusal[RETIRED_LIMIT];
    private final Loci loci = new Loci();
    private final RouteWork routeWork = new RouteWork();
    private final BlockPos[] searchPath = new BlockPos[RELOCATION_HOPS + 1];
    private final BlockPos[] searched = new BlockPos[RELOCATION_HOPS + 1];
    private ClientWorld world;
    private ClientPlayerEntity player;
    private int retiredCursor, lastTurn, started, phaseSince, optionSince, depth, limit, drops;
    private int choice, cut, proof, cutSample;
    private int progressAt, treadEvidence, lightIssuedAt;
    private int caveSince, caveMask, caveContacts;
    private int departureChoice, departureSince, hopCount, pathSize, searchedCount;
    private boolean caveSurveySpent;
    private long revealedFrame = -1, equipmentJob;
    private BlockPos anchor, from, to, detachedRim, workCell, reverseCeiling, pendingLight;
    private BlockPos departureTo, relocationRefused;
    private Vec3d aim, resumeCutAim;
    private Direction preferred, bearing, caveBearing, departureBearing;
    private BlockHitResult departureTop;
    private BlockState departureSurface;
    private AgentSurfaceTread crossing;
    private AgentSurfaceTread.Edge capEscape;
    private Phase phase, afterLight;
    private boolean litHere, trimmed, cavePending, openTread, departureBacktrack;
    private String relocationRefusal;
    private final Face[] faceFacts = new Face[4];
    private Outcome outcome = Outcome.DIVERTED;
    private String status = "";

    AgentReturnableMine(MinecraftClient client, AgentBody body) {
        this.client = client;
        this.body = body;
    }

    boolean active() {
        return phase != null && client.world == world && client.player == player;
    }

    boolean settling() {
        return active() && (phase == Phase.DRIVE || phase == Phase.RELOCATE || checkingReturn());
    }

    boolean surveyingCave() { return active() && cavePending; }

    boolean unjoined() {
        return client.world == world && client.player == player && detachedRim != null;
    }

    String status() { return status; }
    int depth() { return depth; }
    BlockPos witnessedLowCeiling() { return client.player == player && client.world == world ? reverseCeiling : null; }

    boolean hasProgressLease() {
        int now = body.actionTick();
        return continuing(now)
            && (phase == Phase.RELOCATE || phase == Phase.CAP_EXIT || phase == Phase.CHOOSE || phase == Phase.OPEN
                || progressAt >= started && now - progressAt <= PROGRESS_LEASE_TICKS
                || cavePending && now - caveSince <= CAVE_TURN_LIMIT
                || caveSurveySpent && (phase == Phase.ANCHOR || phase == Phase.CHOOSE)
                    && now - phaseSince < CAVE_TURN_LIMIT);
    }

    boolean hasRetryProgressLease() {
        int now = body.actionTick();
        return continuing(now) && (phase == Phase.RELOCATE || phase == Phase.CAP_EXIT || routeWork.recent(now));
    }

    private boolean continuing(int now) {
        return active() && now - lastTurn <= 1 && now - started < timeLimit();
    }

    private int timeLimit() { return phase == Phase.RELOCATE ? RELOCATION_TICKS : LEG_TICKS; }

    boolean stockedForNewLeg(AgentProgress host) {
        return suppliedSteps(host) > 0;
    }

    private static int suppliedSteps(AgentProgress host) {
        return Math.min(host.returnableTorches() - TORCH_RESERVE, (host.returnableToolUses() - TOOL_RESERVE) / 3);
    }

    void observeBreak(BlockPos position) {
        if (witnessedLowCeiling() != null && reverseCeiling.up(2).equals(position)) reverseCeiling = null;
        if (relocationRefused != null && position.getSquaredDistance(relocationRefused) <= 4)
            relocationRefused = null;
        int now = body.actionTick();
        if (active() && !cavePending && lastTurn == now && position.equals(workCell)
                && position.equals(body.continuityMiningTarget())) {
            if (phase == Phase.CUT) {
                routeWork.cut(position, now);
                advanceEvidence(cut, now);
                revealedFrame = body.renderedFrame();
            } else if (phase == Phase.TRIM_RETURN) {
                routeWork.cut(position, now);
                advanceEvidence(22, now);
            }
        }
        for (int i = 0; i < retired.length; i++) {
            Refusal old = retired[i];
            if (old == null) continue;
            BlockPos lane = old.foot.offset(old.bearing);
            if (lane.getX() == position.getX() && lane.getZ() == position.getZ()
                    && position.getY() >= lane.getY() - 2 && position.getY() <= lane.getY() + 2)
                retired[i] = null;
        }
    }

    void issuedLight(BlockPos foot) {
        pendingLight = foot;
        lightIssuedAt = body.actionTick();
    }

    void observeLight(BlockPos foot) {
        int now = body.actionTick();
        if (!continuing(now) || !foot.equals(pendingLight) || now - lightIssuedAt > 8) return;
        pendingLight = null;
        routeWork.light(now);
        progressAt = now;
    }

    void awaitEquipment(long job) { equipmentJob = job; }

    /** Hands keeps physical ownership; only this mine's own safe equipment job preserves its phase. */
    void waitForEquipment(long job) {
        int now = body.actionTick();
        if (job == 0 || job != equipmentJob || !continuing(now) || body.lavaEmergency()
                || player.hurtTime != 0 || player.isOnFire() || player.hasVehicle()
                || !dryGroundAt(checkingReturn() ? to : from)) return;
        lastTurn = now;
    }

    void interruptIfSkipped() {
        if (phase == null || lastTurn == body.actionTick() && active()) return;
        interrupt();
    }

    private void interrupt() {
        markUnjoined();
        finish(Outcome.DIVERTED, "yielding the returnable mine leg to other work");
    }

    Outcome step(AgentProgress host, BlockPos standing, int depth, Direction preference, boolean preferExcavation) {
        resetWorld();
        int now = body.actionTick();
        if (active() && lastTurn != now - 1) interrupt();
        lastTurn = now;
        equipmentJob = 0;
        if (!active()) {
            if (!dryGroundAt(standing)) return finish(Outcome.DIVERTED, "waiting for dry mine footing");
            this.depth = depth;
            preferred = preference;
            if (standing.equals(relocationRefused)) return finish(Outcome.EXHAUSTED, relocationRefusal);
            if (unjoined() || !loci.fresh(standing))
                return relocateFrom(standing, now, "finding a distinct mine start");
            limit = Math.min(LEG_LIMIT, Math.min(standing.getY() - depth, suppliedSteps(host)));
            if (limit <= 0) return finish(Outcome.SUPPLIES, "keeping a light and tool reserve for the mine return");
            anchor = from = standing.toImmutable();
            bearing = null;
            choice = drops = 0;
            caveMask = 0;
            caveSurveySpent = false;
            Arrays.fill(faceFacts, null);
            started = now;
            progressAt = now - PROGRESS_LEASE_TICKS - 1;
            begin(Phase.ANCHOR, now);
            // This detour is optional. A later opening encountered while
            // proving a candidate lane still gets the standard cave checks.
            if (!preferExcavation && player.hurtTime == 0 && !player.isOnFire() && !player.hasVehicle()
                    && host.startMineCaveSurvey(from, preferred)) {
                if (host.mineCaveHandedOff()) return finish(Outcome.DIVERTED, host.status());
                holdCave(host, preferred, now);
                return outcome;
            }
        }
        if (player.isTouchingWater() || player.isInLava() || player.isOnFire()
                || player.hasVehicle() || player.hurtTime > 0) {
            if (phase == Phase.RELOCATE) return finish(Outcome.DIVERTED, "unsafe conditions interrupted mine relocation");
            return fail("unsafe conditions interrupted the returnable mine leg");
        }
        if (cavePending) {
            if (now - caveSince >= CAVE_TURN_LIMIT || now - started >= timeLimit()) {
                if (!host.endMineCaveSurvey()) return finish(Outcome.DIVERTED, "yielding to cave traversal already in motion");
                if (now - started >= timeLimit())
                    return phase == Phase.RELOCATE ? relocationFailed("no distinct dry start before the relocation time limit")
                        : fail("returnable mine leg reached its time limit");
            } else {
                boolean continuing = host.continueMineCaveSurvey(caveBearing);
                if (host.mineCaveHandedOff()) return finish(Outcome.DIVERTED, host.status());
                if (host.caveFootsteps() != caveContacts)
                    return finish(Outcome.DIVERTED, "cave travel reached a new footing");
                if (continuing) return outcome;
            }
            cavePending = false;
            caveSurveySpent = true;
            int paused = now - caveSince;
            phaseSince += paused;
            optionSince += paused;
            if (!dryGroundAt(from)) return finish(Outcome.DIVERTED, "cave travel changed the mine footing");
            status = "resuming mine checks from the retained dry footing";
            return outcome;
        }
        if (phase == Phase.RELOCATE) {
            if (now - started >= RELOCATION_TICKS && (crossing == null || !crossing.inFlight()))
                return relocationFailed("no distinct dry start before the relocation time limit");
            depart(host, now);
            return outcome;
        }
        if (now - started >= LEG_TICKS) return fail("returnable mine leg reached its time limit");
        if (phase != Phase.DRIVE && !dryGroundAt(checkingReturn() ? to : from))
            return fail("lost the committed dry mine stance");
        if (!settling() && phase != Phase.CAP_EXIT && bearing != null
                && body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65))
            return fail("visible lava vetoed the mine bearing");
        switch (phase) {
            case ANCHOR -> anchor(now);
            case CHOOSE -> choose(host, now);
            case OPEN -> open(host, now);
            case CAP_EXIT -> depart(host, now);
            case CUT -> cut(host, now);
            case LIGHT -> light(host, now);
            case FORWARD -> prove(host, now, false);
            case DRIVE -> drive(host, now);
            case REVERSE -> prove(host, now, true);
            case TRIM_RETURN -> trimReturn(host, now);
            case RELOCATE -> depart(host, now);
        }
        return outcome;
    }

    private void anchor(int now) {
        if (now - phaseSince >= 45) {
            if (bearing == null) exhausted(now, "could not witness a full dry mine anchor");
            else fail("could not witness the next full dry mine anchor");
            return;
        }
        Direction direction = bearing == null ? preferred : bearing;
        if (!center(from)) return;
        if (aim == null) aim = offset(Vec3d.ofBottomCenter(from), direction, 0.34).add(0, -0.032, 0);
        body.aim(aim);
        if (body.dryRouteFloor(aim, from.down()) == null) return;
        if (bearing == null) {
            optionSince = now;
            cut = 2;
            cutSample = 0;
            begin(Phase.CHOOSE, now);
        } else {
            prepareCut(now);
        }
    }

    private void choose(AgentProgress host, int now) {
        for (; choice < 4; choice++) {
            Direction candidate = option(choice);
            Face prior = refusal(from, candidate);
            if (prior != null) { faceFacts[choice] = prior; continue; }
            if (body.hazardAhead(candidate.getPositiveHorizontalDegrees(), 1.65)) {
                rejectChoice(candidate, now, Face.LAVA);
                return;
            }
            if (now - optionSince >= 48) {
                rejectChoice(candidate, now, faceFacts[choice] == null ? Face.UNSEEN : faceFacts[choice]);
                return;
            }
            if (aim == null) aimCut(nextTread(candidate), candidate);
            body.aim(aim);
            switch (body.dryCaveSpace(aim)) {
                case CLEAR -> lowerChoice(candidate, now);
                case FLUID -> rejectChoice(candidate, now, Face.FLUID);
                case DARK -> faceFacts[choice] = Face.DARK;
                case UNKNOWN -> {
                    if (cut == 0 && body.renderedAim(aim, 10)) nextCutSample();
                }
                case OBSTRUCTION -> {
                    double reach = player.getEyePos().distanceTo(aim) + 0.04;
                    BlockHitResult face = body.terrain(aim, reach).orElse(null);
                    if (face == null || !face.getBlockPos().equals(workCell)
                            || cut == 0 && !witnessedCap(workCell, candidate, face)) {
                        faceFacts[choice] = Face.OCCLUDED;
                        if (cut == 0 && body.renderedAim(aim, 10)) nextCutSample();
                        return;
                    }
                    Face fact = host.returnableFace(face);
                    BlockHitResult contact = body.perceive(aim, reach).orElse(null);
                    if (contact != null && workCell.equals(contact.getBlockPos())
                            && host.handoffReturnableResource(contact)) {
                        finish(Outcome.DIVERTED, "taking exposed ore before cutting a mine leg");
                    } else if (fact != Face.MINEABLE) {
                        rejectChoice(candidate, now, fact);
                    } else if (contact != null && workCell.equals(contact.getBlockPos())) {
                        bearing = candidate;
                        to = nextTread(candidate);
                        treadEvidence = 0;
                        capEscape = null;
                        trimmed = openTread = false;
                        Vec3d contactAim = aim;
                        begin(Phase.CUT, now);
                        aim = contactAim;
                    } else {
                        faceFacts[choice] = Face.OCCLUDED;
                        if (cut == 0 && body.renderedAim(aim, 10)) nextCutSample();
                    }
                }
            }
            return;
        }
        exhausted(now, refusalSummary());
    }

    private Direction option(int index) {
        return switch (index) {
            case 0 -> preferred;
            case 1 -> preferred.rotateYClockwise();
            case 2 -> preferred.rotateYCounterclockwise();
            default -> preferred.getOpposite();
        };
    }

    private void rejectChoice(Direction candidate, int now, Face fact) {
        retire(from, candidate, fact);
        faceFacts[choice] = fact;
        begin(Phase.CHOOSE, now);
        status = "returnable mine refused " + candidate + " down from " + from.toShortString() + ": " + fact;
        bearing = null;
        choice++;
        cut = 2;
        cutSample = 0;
        optionSince = now;
    }

    private void lowerChoice(Direction candidate, int now) {
        aim = null;
        if (--cut >= 0) return;
        bearing = candidate;
        to = nextTread(candidate);
        begin(Phase.OPEN, now);
    }

    private void open(AgentProgress host, int now) {
        // No obstructing block is a result about excavation, not a witness of flooring.
        var top = lookAtTop(to, bearing);
        if (top == AgentBody.DryRouteTop.FLUID) {
            rejectChoice(bearing, now, Face.FLUID);
            return;
        }
        if (top == AgentBody.DryRouteTop.WITNESSED) {
            if (!body.walkedLaneDry(from, to, bearing)
                    || !AgentSurfaceTread.retainedLaneClear(client, from, to, bearing)) {
                rejectChoice(bearing, now, Face.NO_EXIT);
                return;
            }
            if (body.dryRouteSweep(from, to)) {
                openTread = true;
                treadEvidence = 0;
                trimmed = false;
                begin(Phase.FORWARD, now);
                return;
            }
        }
        if (top == AgentBody.DryRouteTop.NO_FULL_TOP && offerCave(host, to, bearing, now)) return;
        if (now - phaseSince >= 28) rejectChoice(bearing, now, Face.NO_LANDING);
    }

    private boolean offerCave(AgentProgress host, BlockPos planned, Direction direction, int now) {
        int bit = 1 << direction.ordinal();
        if ((caveMask & bit) != 0 || !host.returnableCaveOpening(from, planned, direction)) return false;
        if (host.mineCaveHandedOff()) finish(Outcome.DIVERTED, host.status());
        else holdCave(host, direction, now);
        return true;
    }

    private void holdCave(AgentProgress host, Direction direction, int now) {
        caveMask |= 1 << direction.ordinal();
        cavePending = true;
        caveBearing = direction;
        caveSince = now;
        caveContacts = host.caveFootsteps();
    }

    private void prepareCut(int now) {
        to = nextTread(bearing);
        cut = 2;
        cutSample = 0;
        treadEvidence = 0;
        capEscape = null;
        trimmed = openTread = false;
        begin(Phase.CUT, now);
    }

    private void cut(AgentProgress host, int now) {
        if (now - phaseSince >= 150) {
            fail("could not clear the next returnable mine tread");
            return;
        }
        if (!center(from)) return;
        boolean revealed = revealedFrame >= 0;
        if (revealed) {
            if (revealedFrame == body.renderedFrame() || !body.hasRecentView()) return;
            revealedFrame = -1;
            if (host.handoffVisibleReturnableOre()) {
                finish(Outcome.DIVERTED, "taking newly exposed ore before cutting further");
                return;
            }
        }
        if (revealed) caveMask &= ~(1 << bearing.ordinal()); // Only the edited bearing gained evidence.
        if (aim == null) {
            if (host.returnableToolUses() <= TOOL_RESERVE) {
                finish(Outcome.SUPPLIES, "keeping tool uses in reserve for exposed ore and the return");
                return;
            }
            aimCut(to, bearing);
        }
        if (cut == 0) {
            body.aim(aim);
            switch (body.dryCaveSpace(aim)) {
                case CLEAR -> { begin(Phase.FORWARD, now); return; }
                case DARK -> { if (body.renderedAim(aim, 14)) needLight(host, now); return; }
                case FLUID -> { fail("visible fluid blocked the cut"); return; }
                case UNKNOWN -> { if (body.renderedAim(aim, 10)) nextCutSample(); return; }
                case OBSTRUCTION -> {
                    double reach = player.getEyePos().distanceTo(aim) + 0.04;
                    BlockHitResult cap = body.perceive(aim, reach).orElse(null);
                    if (!witnessedCap(workCell, bearing, cap)) {
                        if (body.renderedAim(aim, 10)) nextCutSample();
                        return;
                    }
                    Face fact = host.returnableFace(cap);
                    if (fact != Face.MINEABLE) {
                        if (host.handoffReturnableResource(cap))
                            finish(Outcome.DIVERTED, "taking exposed ore before cutting further");
                        else fail("the witnessed stair cap is " + fact);
                        return;
                    }
                    if (capEscape == null || !edgeStillClear(capEscape)) {
                        resumeCutAim = aim;
                        begin(Phase.CAP_EXIT, now);
                        resetDeparture(now);
                        return;
                    }
                }
            }
        }
        switch (host.clearReturnable(workCell, aim)) {
            case CLEAR -> {
                aim = null;
                if (--cut < 0) begin(Phase.FORWARD, now);
            }
            case DARK -> needLight(host, now);
            case BLOCKED, LIP -> fail("a witnessed obstruction refused the returnable mine cut");
            case RESOURCE -> finish(Outcome.DIVERTED, "taking exposed ore before cutting further");
            case LOOKING -> {}
        }
    }

    private void needLight(AgentProgress host, int now) {
        if (litHere || host.returnableTorches() <= TORCH_RESERVE) {
            fail("could not see the next dry mine tread without spending the light reserve");
            return;
        }
        litHere = true;
        afterLight = phase;
        host.startReturnableLight();
        begin(Phase.LIGHT, now);
    }

    private void light(AgentProgress host, int now) {
        if (host.returnableTorches() < TORCH_RESERVE) {
            if (checkingReturn()) fail("keeping the remaining light on an unproved return");
            else finish(Outcome.SUPPLIES, "keeping the remaining light for the mine return");
            return;
        }
        BlockPos foot = afterLight == Phase.REVERSE ? to : from;
        switch (host.lightReturnableStair(foot, afterLight == Phase.REVERSE ? bearing.getOpposite() : bearing)) {
            case CLEAR -> begin(afterLight, now);
            case BLOCKED -> fail("could not light the dry stair from its witnessed support");
            default -> {}
        }
    }

    private void prove(AgentProgress host, int now, boolean reverse) {
        BlockPos source = reverse ? to : from, target = reverse ? from : to;
        Direction direction = reverse ? bearing.getOpposite() : bearing;
        if (now - phaseSince >= 83) {
            fail(reverse ? "could not verify a usable reverse edge from the landing"
                : "could not verify dry clearance and a supported landing");
            return;
        }
        if (!center(source)) return;
        if (reverse && trimmed && proof > CLEARANCE_HEIGHTS.length * 2) {
            recheckForward(host, now);
            return;
        }
        int samples = CLEARANCE_HEIGHTS.length * 2;
        if (proof < samples) {
            if (aim == null) {
                double height = CLEARANCE_HEIGHTS[proof / 2];
                boolean takeoff = reverse && proof / 2 == CLEARANCE_HEIGHTS.length - 1;
                Vec3d center = offset(Vec3d.ofBottomCenter(takeoff ? source : target), direction, 0.21);
                double flank = (proof & 1) == 0 ? 1 : -1;
                aim = offset(center.add(0, height, 0), direction.rotateYClockwise(),
                    flank * (player.getWidth() * 0.5 + 0.035));
            }
            body.aim(aim);
            switch (body.dryRouteClear(aim)) {
                case CLEAR -> {
                    checkedEvidence((reverse ? 12 : 3) + proof, now);
                    proof++;
                    aim = null;
                }
                case DARK -> {
                    if (body.renderedAim(aim, 14)) needLight(host, now);
                }
                case FLUID -> fail("a visible fluid interrupted the dry mine route");
                case OBSTRUCTION, UNKNOWN -> {
                    if (reverse && !openTread && proof >= 4 && body.renderedAim(aim, 14))
                        considerReturnTrim(host, now);
                }
            }
            return;
        }
        if (aim == null) aim = offset(Vec3d.ofBottomCenter(target), direction, 0.34).add(0, -0.035, 0);
        body.aim(aim);
        var top = body.dryRouteTop(aim, target.down());
        if (top != AgentBody.DryRouteTop.WITNESSED) {
            if (!reverse && top == AgentBody.DryRouteTop.NO_FULL_TOP) offerCave(host, to, bearing, now);
            return;
        }
        if (!body.dryRouteSweep(source, target)) return;
        if (!reverse) {
            checkedEvidence(11, now);
            begin(Phase.DRIVE, now);
            return;
        }
        if (trimmed) {
            checkedEvidence(23, now);
            proof++;
            aim = null;
            return;
        }
        completeTread(host, now);
    }

    private void considerReturnTrim(AgentProgress host, int now) {
        BlockHitResult obstruction = body.terrain(aim, player.getEyePos().distanceTo(aim) + 0.025).orElse(null);
        if (obstruction == null) return;
        BlockPos cell = obstruction.getBlockPos();
        // Only the two columns already involved in this exact reverse jump.
        if (!cell.equals(to.up(2)) && !cell.equals(from.up())) return;
        advanceEvidence(24, now);
        if (cell.equals(to.up(2))) reverseCeiling = to;
        if (trimmed || host.returnableToolUses() <= TOOL_RESERVE
                || !host.returnableCutAllowed(obstruction)) {
            fail("visible reverse headroom obstructs the known mine tread");
            return;
        }
        workCell = cell;
        Vec3d cutAim = obstruction.getPos().lerp(Vec3d.ofCenter(cell), 0.06);
        trimmed = true;
        begin(Phase.TRIM_RETURN, now);
        aim = cutAim;
    }

    private void trimReturn(AgentProgress host, int now) {
        if (now - phaseSince >= 75 || body.hazardAhead(bearing.getOpposite().getPositiveHorizontalDegrees(), 1.65)) {
            fail("could not safely clear the witnessed reverse headroom");
            return;
        }
        if (!center(to)) return;
        switch (host.clearReturnableHeadroom(workCell, aim)) {
            case CLEAR -> {
                if ((treadEvidence & (1 << 22)) == 0) {
                    fail("reverse headroom changed without a confirmed cut");
                    return;
                }
                if (workCell.equals(to.up(2))) reverseCeiling = null;
                begin(Phase.REVERSE, now);
            }
            case LOOKING -> {}
            default -> fail("visible reverse headroom cannot be safely cleared");
        }
    }

    private void recheckForward(AgentProgress host, int now) {
        // Reobserve the edited destination column with the real lower camera.
        // The reverse sweep checks both columns in the already traversed pair.
        int sample = proof - CLEARANCE_HEIGHTS.length * 2 - 1;
        Vec3d base = Vec3d.ofBottomCenter(to);
        if (sample < CLEARANCE_HEIGHTS.length) {
            if (aim == null) aim = offset(base, bearing, 0.33).add(0, CLEARANCE_HEIGHTS[sample], 0);
            body.aim(aim);
            switch (body.dryRouteClear(aim)) {
                case CLEAR -> {
                    checkedEvidence(25 + sample, now);
                    proof++;
                    aim = null;
                }
                case FLUID -> fail("fluid entered the repaired mine tread");
                case UNKNOWN, DARK, OBSTRUCTION -> {}
            }
            return;
        }
        if (aim == null) aim = offset(base, bearing, 0.34).add(0, -0.035, 0);
        body.aim(aim);
        if (body.dryRouteFloor(aim, to.down()) != null && body.dryRouteSweep(to, from)) completeTread(host, now);
    }

    private void completeTread(AgentProgress host, int now) {
        host.recordReturnableDrop(from, to, bearing);
        if (++drops == limit) {
            finish(Outcome.REACHED, "reached " + drops + " lower dry mine treads with verified return edges");
        } else {
            from = to;
            to = null;
            caveMask = 0;
            caveSurveySpent = false;
            begin(Phase.ANCHOR, now);
        }
    }

    private void drive(AgentProgress host, int now) {
        if (dryGroundAt(to)) {
            checkedEvidence(21, now);
            begin(Phase.REVERSE, now);
            return;
        }
        if (now - phaseSince >= 36 || player.getY() < to.getY() - 0.055) {
            fail("did not settle on the witnessed mine tread");
            return;
        }
        if (body.walkedLaneDry(from, to, bearing) && body.dryRouteSweep(from, to)
                && (!openTread || AgentSurfaceTread.retainedLaneClear(client, from, to, bearing))) {
            double along = (player.getX() - from.getX() - 0.5) * bearing.getOffsetX()
                + (player.getZ() - from.getZ() - 0.5) * bearing.getOffsetZ();
            if (along >= 0.55) checkedEvidence(20, now);
            body.driveDryRoute(from, to, bearing);
            host.rememberReturnableMotion();
        }
    }

    private Outcome exhausted(int now, String reason) {
        loci.exhausted(from);
        return relocateFrom(from, now, reason);
    }

    private Outcome relocateFrom(BlockPos foot, int now, String reason) {
        from = foot.toImmutable();
        searchPath[0] = searched[0] = from;
        pathSize = searchedCount = 1;
        hopCount = caveMask = 0;
        crossing = null;
        bearing = null;
        cavePending = false;
        started = now;
        begin(Phase.RELOCATE, now);
        resetDeparture(now);
        status = reason + "; looking for a separately witnessed dry route to a new mine start";
        return outcome;
    }

    private Outcome relocationFailed(String reason) {
        status = reason + (unjoined() ? "; no usable return to the upper footing was proved" : "");
        BlockPos standing = player.getBlockPos();
        if (!dryGroundAt(standing)) return finish(Outcome.DIVERTED, status);
        relocationRefused = standing.toImmutable();
        relocationRefusal = status;
        return finish(Outcome.EXHAUSTED, status);
    }

    private void resetDeparture(int now) {
        departureChoice = 0;
        departureBacktrack = false;
        clearDeparture(now);
    }

    private void clearDeparture(int now) {
        departureSince = now;
        departureTo = null;
        departureTop = null;
        departureSurface = null;
    }

    private void depart(AgentProgress host, int now) {
        boolean escapingCap = phase == Phase.CAP_EXIT;
        if (crossing != null) {
            switch (crossing.step(client, body, now)) {
                case CHECKING -> { }
                case MOVING -> host.rememberReturnableMotion();
                case LANDED -> {
                    BlockPos landing = crossing.to;
                    host.recordReturnableRelocation(from, landing, departureBearing);
                    if (detachedRim != null && landing.getY() >= detachedRim.getY()) detachedRim = null;
                    from = landing;
                    hopCount++;
                    if (departureBacktrack) pathSize--;
                    else {
                        searchPath[pathSize++] = landing;
                        searched[searchedCount++] = landing;
                    }
                    crossing = null;
                    if (!unjoined() && loci.fresh(from)) {
                        relocationRefused = null;
                        finish(Outcome.REACHED, "reached a distinct dry mine start along checked terrain");
                        return;
                    }
                    caveMask = 0;
                    resetDeparture(now);
                    status = "continuing away from the exhausted mine start on checked dry terrain";
                }
                case REFUSED -> {
                    String reason = crossing.refusal();
                    crossing = null;
                    if (dryGroundAt(from) && !departureBacktrack) clearDeparture(now);
                    else relocationFailed("the witnessed relocation could not settle: " + reason);
                }
            }
            return;
        }
        if (escapingCap && now - phaseSince >= CAP_EXIT_TICKS
                || !escapingCap && hopCount >= RELOCATION_HOPS) {
            if (escapingCap) fail("no independent dry exit was proved before cutting the cap");
            else relocationFailed("the checked relocation reached its walking limit without a distinct dry start");
            return;
        }
        if (!dryGroundAt(from)) {
            if (escapingCap) fail("lost the footing at the mine cap");
            else relocationFailed("lost the grounded footing for mine relocation");
            return;
        }
        if (!center(from)) return;
        if (departureTo == null && !nextDeparture(host, escapingCap, now)) {
            if (escapingCap) fail("no independent dry exit was proved before cutting the cap");
            else relocationFailed("no further safe opening, grounded level tread, or one-block rise was proved");
            return;
        }
        Direction lane = departureBearing;
        if (!body.hazardAhead(lane.getPositiveHorizontalDegrees(), 1.65)) {
            var edge = observeDeparture(now);
            if (edge != null) {
                if (escapingCap) {
                    capEscape = edge;
                    begin(Phase.CUT, now);
                    aim = resumeCutAim;
                } else {
                    crossing = from.getY() == departureTo.getY() ? AgentSurfaceTread.witnessedOutbound(edge, now)
                        : AgentSurfaceTread.ordinaryGrade(edge, from, now);
                    status = from.getY() < departureTo.getY() ? "climbing to a witnessed dry top with clear headroom"
                        : "following a witnessed dry tread away from the exhausted mine start";
                }
                return;
            }
            if (now - departureSince < DEPARTURE_VIEW_TICKS) return;
            // Upward or level travel wins over a sky/air cue. Offer a cave only
            // when this bearing really exposes space below the retained footing.
            BlockPos lower = from.offset(lane).down();
            Vec3d opening = offset(Vec3d.ofCenter(lower, 0.83), lane, 0.37);
            if (!escapingCap && !unjoined() && !departureBacktrack
                    && body.dryCaveSpace(opening) == AgentBody.DryRouteSample.CLEAR
                    && offerCave(host, lower, lane, now)) return;
        }
        if (!departureBacktrack) clearDeparture(now);
        else relocationFailed("could not reverify the last dry tread to try a different relocation bearing");
    }

    private boolean nextDeparture(AgentProgress host, boolean escapingCap, int now) {
        while (departureChoice <= 8) {
            int index = departureChoice++;
            BlockPos candidate;
            if (index == 0) {
                candidate = unjoined() ? detachedRim : host.returnableRetainedStep(from);
                if (candidate == null) continue;
            } else {
                int lane = (index - 1) / 2;
                boolean upward = ((index - 1) % 2 == 0) == unjoined();
                candidate = from.offset(option(lane)).up(upward ? 1 : 0);
            }
            if (escapingCap && candidate.getX() == to.getX() && candidate.getZ() == to.getZ()) continue;
            if (!escapingCap && seenDuringRelocation(candidate)) continue;
            if (selectDeparture(candidate, now)) return true;
        }
        if (!escapingCap && pathSize > 1 && selectDeparture(searchPath[pathSize - 2], now)) {
            departureBacktrack = true;
            return true;
        }
        return false;
    }

    private boolean seenDuringRelocation(BlockPos candidate) {
        for (int i = 0; i < searchedCount; i++) if (candidate.equals(searched[i])) return true;
        return false;
    }

    private boolean selectDeparture(BlockPos candidate, int now) {
        for (Direction lane : CARDINALS) {
            if (!AgentSurfaceTread.cardinalTread(from, candidate, lane)) continue;
            departureTo = candidate;
            departureBearing = lane;
            departureSince = now;
            return true;
        }
        return false;
    }

    private AgentSurfaceTread.Edge observeDeparture(int now) {
        BlockState source = body.dryCaveContact(from);
        var options = client.options;
        boolean grade = from.getY() != departureTo.getY();
        if (source == null || options.forwardKey.isUnbound() || grade && options.jumpKey.isUnbound()) return null;
        BlockPos support = departureTo.down();
        Vec3d center = Vec3d.ofBottomCenter(departureTo);
        Vec3d floor = floorAim(departureTo, departureBearing);
        if (departureTop == null) {
            body.aim(floor);
            departureTop = body.dryRouteFloor(floor, support);
            if (departureTop == null) {
                // A miss supplies no grade. Move on promptly once we've actually seen the gap or fluid.
                var top = body.dryRouteTop(floor, support, true);
                if (top == AgentBody.DryRouteTop.FLUID || top == AgentBody.DryRouteTop.NO_FULL_TOP
                        || top == AgentBody.DryRouteTop.UNSUITABLE_TOP
                        || top == AgentBody.DryRouteTop.OCCLUDED && body.renderedAim(floor, 8))
                    departureSince = now - DEPARTURE_VIEW_TICKS;
                return null;
            }
            departureSurface = world.getBlockState(support); // The precise top just witnessed.
        }
        Vec3d head = center.add(0, 1.76, 0);
        body.aim(center.add(0, 1.38, 0));
        var upper = body.dryCaveSpace(head);
        var chest = body.dryCaveSpace(center.add(0, 0.98, 0));
        if (upper == AgentBody.DryRouteSample.FLUID || chest == AgentBody.DryRouteSample.FLUID
                || upper == AgentBody.DryRouteSample.OBSTRUCTION || chest == AgentBody.DryRouteSample.OBSTRUCTION) {
            departureSince = now - DEPARTURE_VIEW_TICKS;
            return null;
        }
        if (upper != AgentBody.DryRouteSample.CLEAR || chest != AgentBody.DryRouteSample.CLEAR) return null;
        if (departureSurface != world.getBlockState(support)) {
            departureSince = now - DEPARTURE_VIEW_TICKS;
            return null;
        }
        boolean clear = body.walkedLaneDry(from, departureTo, departureBearing)
            && AgentSurfaceTread.retainedLaneClear(client, from, departureTo, departureBearing)
            && (grade ? body.ordinaryGradeSweep(from, departureTo) : body.dryRouteSweep(from, departureTo));
        if (!clear) departureSince = now - DEPARTURE_VIEW_TICKS;
        return witnessedTransit(from, departureTo, departureBearing, departureTop, source, departureSurface, clear);
    }

    private boolean edgeStillClear(AgentSurfaceTread.Edge edge) {
        boolean forward = from.equals(edge.upper());
        BlockPos other = forward ? edge.lower() : edge.upper();
        Direction lane = forward ? edge.down() : edge.down().getOpposite();
        return !body.hazardAhead(lane.getPositiveHorizontalDegrees(), 1.65)
            && world.getBlockState(edge.upper().down()) == edge.upperSupport()
            && world.getBlockState(edge.lower().down()) == edge.lowerSupport()
            && body.walkedLaneDry(from, other, lane) && AgentSurfaceTread.retainedLaneClear(client, from, other, lane);
    }

    static AgentSurfaceTread.Edge witnessedTransit(BlockPos from, BlockPos to, Direction lane, BlockHitResult top,
                                                  BlockState source, BlockState landing, boolean clear) {
        if (!clear || top == null || top.isInsideBlock() || source == null || landing == null
                || AgentBody.dryCaveDanger(source) || AgentBody.dryCaveDanger(landing)
                || !AgentBody.matchesDryRouteTop(top, to.down())
                || !AgentSurfaceTread.cardinalTread(from, to, lane)) return null;
        return from.getY() == to.getY() ? new AgentSurfaceTread.Edge(from, source, to, landing, lane)
            : AgentSurfaceTread.witnessedGradeEdge(from, source, lane, top, landing, clear);
    }

    private AgentBody.DryRouteTop lookAtTop(BlockPos foot, Direction lane) {
        Vec3d floor = floorAim(foot, lane);
        body.aim(floor);
        return body.dryRouteTop(floor, foot.down(), true);
    }

    private static Vec3d floorAim(BlockPos foot, Direction lane) {
        return offset(Vec3d.ofBottomCenter(foot), lane, 0.42).add(0, -0.032, 0);
    }

    private void checkedEvidence(int evidence, int now) {
        if (advanceEvidence(evidence, now)) routeWork.proved(now);
    }

    private boolean advanceEvidence(int evidence, int now) {
        int bit = 1 << evidence;
        if ((treadEvidence & bit) != 0) return false;
        treadEvidence |= bit;
        progressAt = now;
        return true;
    }

    private boolean dryGroundAt(BlockPos foot) {
        return foot != null && player.isOnGround() && !player.isTouchingWater() && !player.isInLava()
            && Math.abs(player.getY() - foot.getY()) <= 0.055 && foot.equals(player.getBlockPos());
    }

    private boolean checkingReturn() {
        return phase == Phase.REVERSE || phase == Phase.TRIM_RETURN || phase == Phase.LIGHT && afterLight == Phase.REVERSE;
    }

    private boolean center(BlockPos foot) {
        double x = Math.abs(player.getX() - foot.getX() - 0.5), z = Math.abs(player.getZ() - foot.getZ() - 0.5);
        if (x > 0.17 || z > 0.17) {
            body.centerOnSupport(foot.down());
            return false;
        }
        return player.getVelocity().horizontalLengthSquared() <= 0.0025;
    }

    private void begin(Phase next, int now) {
        outcome = Outcome.WORKING;
        phase = next;
        phaseSince = now;
        proof = 0;
        aim = null;
        if (next == Phase.ANCHOR) {
            litHere = false;
            pendingLight = null;
            routeWork.reset();
        }
        status = switch (next) {
            case ANCHOR -> "checking the stable dry anchor for a returnable mine leg";
            case CHOOSE -> "looking for a witnessed mine face on a safe bearing";
            case OPEN -> "no obstruction to cut; looking for the exact dry landing of the opening";
            case CAP_EXIT -> "checking an independent dry exit before cutting a witnessed cap";
            case CUT -> "clearing one witnessed cell of the returnable mine stair";
            case LIGHT -> "lighting the dry mine tread from stable support";
            case FORWARD -> "checking the next dry mine tread and its jump clearance";
            case DRIVE -> "walking onto the witnessed dry mine tread";
            case REVERSE -> "checking the reverse climb from the grounded mine tread";
            case TRIM_RETURN -> "clearing one witnessed block from the known reverse climb";
            case RELOCATE -> "looking for a distinct dry mine start";
        };
    }

    private Outcome fail(String detail) {
        int now = body.actionTick();
        markUnjoined();
        if (bearing != null) {
            retire(anchor, bearing, Face.FAILED);
            if (!from.equals(anchor)) retire(from, bearing, Face.FAILED);
            if (checkingReturn()) retire(to, bearing.getOpposite(), Face.FAILED);
        }
        if (unjoined() && dryGroundAt(player.getBlockPos()) && player.hurtTime == 0
                && !player.isOnFire() && !player.hasVehicle()) {
            loci.exhausted(detachedRim);
            return relocateFrom(player.getBlockPos(), now, detail);
        }
        return finish(Outcome.FAILED, detail);
    }

    private void markUnjoined() {
        if (active() && (phase == Phase.DRIVE || checkingReturn()) && player.getY() < from.getY() - 0.055)
            detachedRim = from;
    }

    private Outcome finish(Outcome result, String detail) {
        phase = null;
        cavePending = false;
        anchor = from = to = workCell = null;
        crossing = null;
        capEscape = null;
        resumeCutAim = null;
        clearDeparture(body.actionTick());
        pendingLight = null;
        equipmentJob = 0;
        revealedFrame = -1;
        status = detail;
        return outcome = result;
    }

    private void resetWorld() {
        if (client.world == world && client.player == player) return;
        world = client.world;
        player = client.player;
        phase = null;
        cavePending = false;
        detachedRim = reverseCeiling = relocationRefused = null;
        relocationRefusal = null;
        pendingLight = null;
        equipmentJob = 0;
        revealedFrame = -1;
        Arrays.fill(retired, null);
        retiredCursor = 0;
        loci.clear();
    }

    private Face refusal(BlockPos foot, Direction direction) {
        for (Refusal refusal : retired)
            if (refusal != null && refusal.bearing == direction && refusal.foot.equals(foot)) return refusal.fact;
        return null;
    }

    private void retire(BlockPos foot, Direction direction, Face fact) {
        if (foot != null && refusal(foot, direction) == null)
            retired[retiredCursor++ % retired.length] = new Refusal(foot, direction, fact);
    }

    private String refusalSummary() {
        StringBuilder summary = new StringBuilder("no verified descending bearing: ");
        for (int i = 0; i < faceFacts.length; i++) {
            if (i > 0) summary.append(", ");
            summary.append(option(i)).append('=').append(faceFacts[i]);
        }
        return summary.toString();
    }

    private void aimCut(BlockPos foot, Direction direction) {
        workCell = foot.up(cut);
        aim = cut == 0 ? capAim(workCell, direction, cutSample) : Vec3d.ofCenter(workCell);
    }

    static Vec3d capAim(BlockPos cell, Direction direction, int sample) {
        // A high ray on the far half sees over the retained lip. A flank can
        // reach the same natural face around a grass outline without breaking it.
        double flank = sample == 0 ? 0 : sample == 1 ? 0.34 : -0.34;
        return offset(offset(Vec3d.ofCenter(cell, 0.95), direction, 0.40), direction.rotateYClockwise(), flank);
    }

    private void nextCutSample() {
        cutSample = (cutSample + 1) % 3;
        aim = null;
    }

    private BlockPos nextTread(Direction direction) {
        return from.offset(direction).down();
    }

    static boolean witnessedCap(BlockPos cap, Direction bearing, BlockHitResult hit) {
        return hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && cap.equals(hit.getBlockPos())
            && (AgentBody.matchesDryRouteTop(hit, cap) || hit.getSide() == bearing.getOpposite());
    }

    /** Negative-only attachment veto for this already witnessed cut, never a search for usable terrain. */
    static boolean protectedCutAttachment(BlockView world, BlockPos cap) {
        BlockState above = world.getBlockState(cap.up());
        if (above.isOf(Blocks.TORCH) || above.isOf(Blocks.SOUL_TORCH) || above.isOf(Blocks.REDSTONE_TORCH)
                || above.isOf(Blocks.CRAFTING_TABLE) || above.isOf(Blocks.FURNACE)) return true;
        for (Direction outward : CARDINALS) {
            BlockState side = world.getBlockState(cap.offset(outward));
            if ((side.isOf(Blocks.WALL_TORCH) || side.isOf(Blocks.SOUL_WALL_TORCH)
                    || side.isOf(Blocks.REDSTONE_WALL_TORCH)) && side.get(Properties.HORIZONTAL_FACING) == outward)
                return true;
        }
        return false;
    }

    private static Vec3d offset(Vec3d vector, Direction direction, double distance) {
        return vector.add(distance * direction.getOffsetX(), 0, distance * direction.getOffsetZ());
    }
}
