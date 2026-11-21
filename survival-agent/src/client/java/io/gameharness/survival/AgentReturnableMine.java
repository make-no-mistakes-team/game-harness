package io.gameharness.survival;

import java.util.Arrays;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** A short ordinary mine job. Only its next tread is an excavation intention. */
final class AgentReturnableMine {
    private static final int LEG_LIMIT = 3;
    private static final int TORCH_RESERVE = 2;
    private static final int TOOL_RESERVE = 4;
    private static final int LEG_TICKS = 520;
    private static final int PROGRESS_LEASE_TICKS = 48;
    private static final int CAVE_TURN_LIMIT = 220;
    private static final int RETIRED_LIMIT = 32;
    // The tallest samples cover the lower tread's jump takeoff, not just standing room.
    private static final double[] CLEARANCE_HEIGHTS = {0.20, 0.97, 1.79, 2.86};

    enum Outcome { WORKING, REACHED, FAILED, DIVERTED, EXHAUSTED, SUPPLIES }
    private enum Phase { ANCHOR, CHOOSE, CUT, LIGHT, FORWARD, DRIVE, REVERSE, TRIM_RETURN }
    private record Refusal(BlockPos foot, Direction bearing, boolean level, Face fact) {}
    enum Face { UNSEEN, OPEN, DARK, OCCLUDED, FLUID, LAVA, FOOTPRINT, PROTECTED, MATERIAL, TOOL, FAILED, MINEABLE }

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
    private final RouteWork routeWork = new RouteWork();
    private ClientWorld world;
    private ClientPlayerEntity player;
    private int retiredCursor, lastTurn, started, phaseSince, optionSince, depth, limit, drops;
    private int choice, cut, proof;
    private int progressAt, treadEvidence, lightIssuedAt;
    private int caveSince, caveMask, caveContacts;
    private boolean caveSurveySpent;
    private long revealedFrame = -1, equipmentJob;
    private BlockPos anchor, from, to, unjoined, levelFoot, workCell, reverseCeiling, pendingLight;
    private Vec3d aim;
    private Direction preferred, bearing, caveBearing;
    private Phase phase, afterLight;
    private boolean litHere, trimmed, levelOnly, levelSpent, cavePending, levelFallback;
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
        return active() && (phase == Phase.DRIVE || checkingReturn());
    }

    boolean surveyingCave() { return active() && cavePending; }

    boolean unjoined(BlockPos foot) {
        return client.world == world && client.player == player && (foot.equals(unjoined) || foot.equals(levelFoot));
    }

    String status() { return status; }
    int depth() { return depth; }
    BlockPos witnessedLowCeiling() { return client.player == player && client.world == world ? reverseCeiling : null; }

    boolean hasProgressLease() {
        int now = body.actionTick();
        return continuing(now)
            && (progressAt >= started && now - progressAt <= PROGRESS_LEASE_TICKS
                || cavePending && now - caveSince <= CAVE_TURN_LIMIT
                || caveSurveySpent && (phase == Phase.ANCHOR || phase == Phase.CHOOSE)
                    && now - phaseSince < CAVE_TURN_LIMIT);
    }

    boolean hasRetryProgressLease() {
        int now = body.actionTick();
        return continuing(now) && routeWork.recent(now);
    }

    private boolean continuing(int now) {
        return active() && now - lastTurn <= 1 && now - started < LEG_TICKS;
    }

    boolean stockedForNewLeg(AgentProgress host) {
        return suppliedSteps(host) > 0;
    }

    private static int suppliedSteps(AgentProgress host) {
        return Math.min(host.returnableTorches() - TORCH_RESERVE, (host.returnableToolUses() - TOOL_RESERVE) / 3);
    }

    void observeBreak(BlockPos position) {
        if (witnessedLowCeiling() != null && reverseCeiling.up(2).equals(position)) reverseCeiling = null;
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
            levelOnly = unjoined(standing);
            if (levelOnly && levelSpent)
                return finish(Outcome.EXHAUSTED, "no verified return from the new tread");
            if (!dryGroundAt(standing)) return finish(Outcome.DIVERTED, "waiting for dry mine footing");
            limit = Math.min(levelOnly ? 1 : LEG_LIMIT,
                Math.min(levelOnly ? 1 : standing.getY() - depth, suppliedSteps(host)));
            if (limit <= 0) return finish(levelOnly ? Outcome.EXHAUSTED : Outcome.SUPPLIES,
                "keeping a light and tool reserve for the mine return");
            anchor = from = standing.toImmutable();
            this.depth = depth;
            preferred = levelOnly ? preference.rotateYClockwise() : preference;
            bearing = null;
            choice = drops = 0;
            levelFallback = levelOnly;
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
            return fail("unsafe conditions interrupted the returnable mine leg");
        }
        if (cavePending) {
            if (now - caveSince >= CAVE_TURN_LIMIT || now - started >= LEG_TICKS) {
                if (!host.endMineCaveSurvey()) return finish(Outcome.DIVERTED, "yielding to cave traversal already in motion");
                if (now - started >= LEG_TICKS) return fail("returnable mine leg reached its time limit");
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
        if (now - started >= LEG_TICKS) return fail("returnable mine leg reached its time limit");
        if (phase != Phase.DRIVE && !dryGroundAt(checkingReturn() ? to : from))
            return fail("lost the committed dry mine stance");
        if (!settling() && bearing != null && body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65))
            return fail("visible lava vetoed the mine bearing");
        switch (phase) {
            case ANCHOR -> anchor(now);
            case CHOOSE -> choose(host, now);
            case CUT -> cut(host, now);
            case LIGHT -> light(host, now);
            case FORWARD -> prove(host, now, false);
            case DRIVE -> drive(host, now);
            case REVERSE -> prove(host, now, true);
            case TRIM_RETURN -> trimReturn(host, now);
        }
        return outcome;
    }

    private void anchor(int now) {
        if (now - phaseSince >= 45) {
            if (bearing == null) finish(Outcome.EXHAUSTED, "could not witness a full dry mine anchor");
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
            cut = levelOnly ? 1 : 2;
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
            if (now - optionSince >= 42) {
                rejectChoice(candidate, now, faceFacts[choice] == null ? Face.UNSEEN : faceFacts[choice]);
                return;
            }
            if (aim == null) aimCut(nextTread(candidate), candidate);
            body.aim(aim);
            BlockHitResult hit = body.perceive(aim, player.getEyePos().distanceTo(aim) + 0.04).orElse(null);
            if (hit != null && hit.getBlockPos().equals(workCell)) {
                if (host.handoffReturnableResource(hit)) {
                    finish(Outcome.DIVERTED, "taking exposed ore before cutting a mine leg");
                } else {
                    Face face = host.returnableFace(hit);
                    if (face == Face.MINEABLE) {
                        bearing = candidate;
                        prepareCut(now);
                    } else if (body.dryRouteClear(aim) != AgentBody.DryRouteSample.CLEAR) {
                        rejectChoice(candidate, now, face);
                    } else {
                        lowerChoice(host, candidate, now);
                    }
                }
                return;
            }
            var sample = body.dryRouteClear(aim);
            if (sample == AgentBody.DryRouteSample.FLUID) rejectChoice(candidate, now, Face.FLUID);
            else if (sample == AgentBody.DryRouteSample.CLEAR) lowerChoice(host, candidate, now);
            else if (sample == AgentBody.DryRouteSample.DARK) faceFacts[choice] = Face.DARK;
            else if (hit != null && faceFacts[choice] != Face.DARK) faceFacts[choice] = Face.OCCLUDED;
            return;
        }
        String refusal = refusalSummary();
        if (!levelFallback && host.returnableToolUses() > TOOL_RESERVE && host.returnableTorches() > TORCH_RESERVE) {
            levelOnly = levelFallback = true;
            limit = 1;
            choice = 0;
            cut = 1;
            aim = null;
            optionSince = now;
            Arrays.fill(faceFacts, null);
            status = refusal + "; checking witnessed level alternatives";
            return;
        }
        finish(Outcome.EXHAUSTED, refusal);
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
        status = "returnable mine refused " + candidate + " " + (levelOnly ? "level" : "down")
            + " from " + from.toShortString() + ": " + fact;
        choice++;
        cut = levelOnly ? 1 : 2;
        aim = null;
        optionSince = now;
    }

    private void lowerChoice(AgentProgress host, Direction candidate, int now) {
        if (cut > 0 && offerCave(host, workCell.down(cut), candidate, now)) return;
        aim = null;
        if (--cut >= 0) return;
        // A clear column needs no excavation. Only a visible supporting top
        // admits the ordinary clearance proof; air alone proves no landing.
        BlockPos landing = nextTread(candidate);
        Vec3d floor = offset(Vec3d.ofBottomCenter(landing), candidate, 0.34).add(0, -0.035, 0);
        if (body.dryRouteFloor(floor, landing.down()) == null || !body.dryRouteSweep(from, landing)) {
            rejectChoice(candidate, now, Face.OPEN);
            return;
        }
        bearing = candidate;
        to = landing;
        treadEvidence = 0;
        trimmed = false;
        begin(Phase.FORWARD, now);
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
        cut = levelOnly ? 1 : 2;
        treadEvidence = 0;
        trimmed = false;
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
        if ((revealed || cut == 0 && aim == null) && offerCave(host, to, bearing, now)) return;
        if (aim == null) {
            if (host.returnableToolUses() <= TOOL_RESERVE) {
                finish(Outcome.SUPPLIES, "keeping tool uses in reserve for exposed ore and the return");
                return;
            }
            aimCut(to, bearing);
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
            else finish(levelOnly ? Outcome.EXHAUSTED : Outcome.SUPPLIES, "keeping the remaining light for the mine return");
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
        if (!reverse && proof == 0 && aim == null && offerCave(host, to, bearing, now)) return;
        int samples = levelOnly ? 6 : CLEARANCE_HEIGHTS.length * 2;
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
                    if (reverse && !levelOnly && proof >= 4 && body.renderedAim(aim, 14))
                        considerReturnTrim(host, now);
                }
            }
            return;
        }
        if (aim == null) aim = offset(Vec3d.ofBottomCenter(target), direction, 0.34).add(0, -0.035, 0);
        body.aim(aim);
        if (body.dryRouteFloor(aim, target.down()) == null || !body.dryRouteSweep(source, target)) return;
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
        if (levelOnly) {
            if (unjoined(from)) {
                levelFoot = to;
                levelSpent = true;
                finish(Outcome.REACHED, "reached one verified level prospecting tread without claiming a depth gain");
            } else {
                host.recordReturnableLevel(from, to, bearing);
                finish(Outcome.REACHED, "reached a verified level prospecting tread");
            }
            return;
        }
        unjoined = levelFoot = null;
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
        if (body.dryRouteSweep(from, to)) {
            double along = (player.getX() - from.getX() - 0.5) * bearing.getOffsetX()
                + (player.getZ() - from.getZ() - 0.5) * bearing.getOffsetZ();
            if (along >= 0.55) checkedEvidence(20, now);
            body.driveDryRoute(from, to, bearing);
            host.rememberReturnableMotion();
        }
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
        return player.isOnGround() && !player.isTouchingWater() && !player.isInLava()
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
            case CUT -> "clearing one witnessed cell of the returnable mine stair";
            case LIGHT -> "lighting the dry mine tread from stable support";
            case FORWARD -> "checking the next dry mine tread and its jump clearance";
            case DRIVE -> "walking onto the witnessed dry mine tread";
            case REVERSE -> "checking the reverse climb from the grounded mine tread";
            case TRIM_RETURN -> "clearing one witnessed block from the known reverse climb";
        };
    }

    private Outcome fail(String detail) {
        int now = body.actionTick();
        boolean tryLevel = checkingReturn() && !levelOnly && dryGroundAt(to) && player.hurtTime == 0
            && !player.isOnFire() && !player.hasVehicle() && now - started < LEG_TICKS;
        markUnjoined();
        if (bearing != null) {
            retire(anchor, bearing, Face.FAILED);
            if (!from.equals(anchor)) retire(from, bearing, Face.FAILED);
            if (checkingReturn()) retire(to, bearing.getOpposite(), Face.FAILED);
        }
        if (tryLevel) {
            // The lower landing is real, but detached. Take no additional drop
            // from it until an actual return is proved by the cave navigator.
            anchor = from = unjoined;
            preferred = bearing.rotateYClockwise();
            bearing = null;
            to = workCell = null;
            levelOnly = true;
            levelSpent = true;
            choice = drops = 0;
            caveMask = 0;
            Arrays.fill(faceFacts, null);
            begin(Phase.ANCHOR, now);
            status = detail + "; checking a level alternative without claiming the drop";
            return outcome;
        }
        return finish(Outcome.FAILED, detail);
    }

    private void markUnjoined() {
        if (settling() && levelOnly && dryGroundAt(to)) {
            levelFoot = to;
            levelSpent = true;
        } else if (settling() && player.getY() < from.getY() - 0.055) {
            unjoined = player.isOnGround() ? player.getBlockPos().toImmutable() : to;
            levelFoot = null;
            levelSpent = false;
        }
    }

    private Outcome finish(Outcome result, String detail) {
        phase = null;
        cavePending = false;
        anchor = from = to = workCell = null;
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
        unjoined = levelFoot = reverseCeiling = null;
        pendingLight = null;
        equipmentJob = 0;
        levelSpent = false;
        revealedFrame = -1;
        Arrays.fill(retired, null);
        retiredCursor = 0;
    }

    private Face refusal(BlockPos foot, Direction direction) {
        for (Refusal refusal : retired)
            if (refusal != null && refusal.bearing == direction && refusal.level == levelOnly
                    && refusal.foot.equals(foot)) return refusal.fact;
        return null;
    }

    private void retire(BlockPos foot, Direction direction, Face fact) {
        if (refusal(foot, direction) == null)
            retired[retiredCursor++ % retired.length] = new Refusal(foot, direction, levelOnly, fact);
    }

    private String refusalSummary() {
        StringBuilder summary = new StringBuilder(levelOnly ? "no verified level alternative: " : "no verified descending bearing: ");
        for (int i = 0; i < faceFacts.length; i++) {
            if (i > 0) summary.append(", ");
            summary.append(option(i)).append('=').append(faceFacts[i]);
        }
        return summary.toString();
    }

    private void aimCut(BlockPos foot, Direction direction) {
        workCell = foot.up(cut);
        aim = cut == 0 && !levelOnly ? offset(Vec3d.ofCenter(workCell, 0.82), direction, 0.22)
            : Vec3d.ofCenter(workCell);
    }

    private BlockPos nextTread(Direction direction) {
        return from.offset(direction).down(levelOnly ? 0 : 1);
    }

    private static Vec3d offset(Vec3d vector, Direction direction, double distance) {
        return vector.add(distance * direction.getOffsetX(), 0, distance * direction.getOffsetZ());
    }
}
