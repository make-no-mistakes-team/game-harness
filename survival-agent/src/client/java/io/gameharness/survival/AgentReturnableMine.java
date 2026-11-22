package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Arrays;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.FallingBlockEntity;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.state.property.Properties;
import net.minecraft.util.TypeFilter;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
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
    private static final int DEPARTURE_VIEW_TICKS = 38;
    private static final int DRIFT_LIMIT = 2;
    private static final int FOOTHOLD_LIMIT = 2;
    static final int WORKSHOP_RESERVE = 8;
    private static final int FOOTHOLD_CONTACT_TICKS = 34, FOOTHOLD_RECEIPT_TICKS = 26;
    private static final int CONNECTOR_VIEWS = 2, CONNECTOR_VIEW_TICKS = 22, CONNECTOR_PEEK_TICKS = 16;
    // The first leg has fresh placement/passage proof; the onward tread still needs its ordinary view window.
    private static final int CONNECTOR_COMMIT_TICKS = FOOTHOLD_RECEIPT_TICKS
        + AgentSurfaceTread.ORDINARY_GRADE_TICKS + AgentSurfaceTread.ACTION_TICKS;
    private static final Direction[] CARDINALS = {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST};
    private static final Direction[] ADJACENT = Direction.values();
    private static final TypeFilter<Entity, FallingBlockEntity> FALLING_ENTITIES =
        TypeFilter.instanceOf(FallingBlockEntity.class);
    // The tallest samples cover the lower tread's jump takeoff, not just standing room.
    private static final double[] CLEARANCE_HEIGHTS = {0.20, 0.97, 1.79, 2.86};

    enum Outcome { WORKING, REACHED, FAILED, DIVERTED, EXHAUSTED, SUPPLIES }
    private enum Phase { ANCHOR, CHOOSE, OPEN, CUT, LIGHT, FORWARD, FOOTHOLD, FOOTHOLD_RECEIPT,
        DRIVE, REVERSE, TRIM_RETURN, RELOCATE }
    private record Refusal(BlockPos foot, Direction bearing, Face fact, String detail) {
        String reason() { return detail == null ? fact.name() : detail; }
    }
    enum Face { UNSEEN, NO_LANDING, NO_EXIT, DARK, OCCLUDED, FLUID, LAVA, FOOTPRINT, PROTECTED, MATERIAL, TOOL,
        FALLING_COVER, UNSETTLED, GRAVEL_LIMIT, FAILED, MINEABLE }

    enum Fall { SETTLED, WAITING, UNSAFE }

    static final class GravelWork {
        private static final int BREAK_LIMIT = 3, QUIET_TICKS = 6, WAIT_LIMIT = 24;
        private int breaks, since = -1, quietSince = -1;

        void reset() {
            breaks = 0;
            since = quietSince = -1;
        }

        boolean canCut() { return breaks < BREAK_LIMIT; }
        boolean waiting() { return since != -1; }

        void broke(int now) {
            breaks++;
            since = now;
            quietSince = -1;
        }

        Fall settle(int now, boolean falling) {
            if (since == -1 && !falling) return Fall.SETTLED;
            if (since == -1) since = now;
            if (falling) quietSince = -1;
            else {
                if (quietSince == -1) quietSince = now;
                if (now - quietSince >= QUIET_TICKS) {
                    since = quietSince = -1;
                    return Fall.SETTLED;
                }
            }
            return now - since >= WAIT_LIMIT ? Fall.UNSAFE : Fall.WAITING;
        }
    }

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
        private boolean lit, supported;

        void reset() {
            cutCount = 0;
            lit = supported = false;
        }

        void cut(BlockPos cell, int now) {
            long packed = cell.asLong();
            for (int i = 0; i < cutCount; i++) if (cuts[i] == packed) return;
            if (cutCount == cuts.length) return;
            cuts[cutCount++] = packed;
            lastProgress = now;
        }

        void gravelCut(BlockPos cell, int now) {
            cut(cell, now);
            lastProgress = now; // A replacement was really broken; GravelWork bounds repetitions.
        }

        void light(int now) {
            if (lit) return;
            lit = true;
            lastProgress = now;
        }

        void support(int now) {
            supported = true;
            lastProgress = now;
        }

        void proved(int now) {
            if (recent(now)) lastProgress = now;
        }

        boolean recent(int now) {
            return (cutCount != 0 || lit || supported) && now - lastProgress <= PROGRESS_LEASE_TICKS;
        }
    }

    record LevelOutlet(BlockPos foot, Direction travel, BlockState support) {}

    /** A stationary use can only complete with a new top at the one selected support. */
    static final class Foothold {
        final BlockPos from, landing, cell;
        final BlockState source;
        final Direction bearing;
        final boolean level;
        final Box volume;
        final Vec3d low, high;
        final int unresolvedSlot;
        LevelOutlet outlet;
        int peekSince = -1;
        BlockState anchorState;
        BlockHitResult anchor;
        private int countBefore;
        private long issuedFrame = -1;

        Foothold(BlockPos from, Direction bearing, BlockState source, int unresolvedSlot) {
            this(from, bearing, source, unresolvedSlot, false);
        }

        Foothold(BlockPos from, Direction bearing, BlockState source, int unresolvedSlot, boolean level) {
            this.from = from;
            this.bearing = bearing;
            this.source = source;
            this.unresolvedSlot = unresolvedSlot;
            this.level = level;
            landing = from.add(bearing.getOffsetX(), level ? 0 : -1, bearing.getOffsetZ());
            cell = landing.down();
            volume = new Box(cell);
            low = AgentBody.footholdInterior(cell, bearing, false);
            high = AgentBody.footholdInterior(cell, bearing, true);
        }

        String placementRefusal(Box hull, int stock, boolean occupied, AgentBody.FootholdSpace low,
                                AgentBody.FootholdSpace high, BlockHitResult face) {
            if (!insideFooting(from, hull) || hull.intersects(volume)) return "the player's body overlaps the footing margin";
            if (level && outlet == null) return "no witnessed supported passage beyond the connector";
            if (stock <= WORKSHOP_RESERVE) return "keeping eight cobblestone for the workshop";
            if (occupied) return "an entity occupies the support cell";
            if (!empty(low, high)) return spaceRefusal(low, high);
            return AgentBody.footholdFaceInEnvelope(face, cell, bearing)
                ? null : "no visible reachable top or side attaches to this exact cell";
        }

        static boolean empty(AgentBody.FootholdSpace low, AgentBody.FootholdSpace high) {
            return low == AgentBody.FootholdSpace.EMPTY && high == AgentBody.FootholdSpace.EMPTY;
        }

        static String spaceRefusal(AgentBody.FootholdSpace low, AgentBody.FootholdSpace high) {
            return "the cell is not witnessed lit and empty (low " + low + ", high " + high + ")";
        }

        void issued(long frame, int stock) {
            issuedFrame = frame;
            countBefore = stock;
        }

        boolean debited(int stock) { return issuedFrame >= 0 && stock == countBefore - 1; }

        boolean confirms(long frame, BlockHitResult top, BlockState shown, int stock) {
            return frame > issuedFrame && debited(stock) && AgentBody.matchesDryRouteTop(top, cell)
                && !top.isInsideBlock() && shown.isOf(Blocks.COBBLESTONE);
        }
    }

    private final MinecraftClient client;
    private final AgentBody body;
    private final Refusal[] retired = new Refusal[RETIRED_LIMIT];
    // An interrupted or unconfirmed use must not be retried or masquerade as a natural landing.
    private final BlockPos[] unresolvedFootholds = new BlockPos[RETIRED_LIMIT];
    private final BlockPos.Mutable footholdProbe = new BlockPos.Mutable();
    private final Loci loci = new Loci();
    private final RouteWork routeWork = new RouteWork();
    private final GravelWork gravelWork = new GravelWork();
    private final ArrayList<FallingBlockEntity> fallingBlocks = new ArrayList<>(1);
    private final BlockPos[] searchPath = new BlockPos[RELOCATION_HOPS + 1];
    private final BlockPos[] searched = new BlockPos[RELOCATION_HOPS + 1];
    private final long[] driftTargets = new long[DRIFT_LIMIT];
    private ClientWorld world;
    private ClientPlayerEntity player;
    private int retiredCursor, lastTurn, started, phaseSince, optionSince, depth, limit, drops;
    private int footholdUses, connectorViews;
    private int choice, cut, proof, cutSample, floorSample;
    private int progressAt, treadEvidence, lightIssuedAt;
    private int caveSince, caveMask, caveContacts;
    private int departureChoice, departureSince, hopCount, pathSize, searchedCount;
    private int driftAttempts, driftFaces, driftSearchStarted;
    private boolean caveSurveySpent, connectorPeekSpent, detachedLevel;
    private long revealedFrame = -1, equipmentJob;
    private BlockPos anchor, from, to, detachedRim, workCell, reverseCeiling, pendingLight;
    private BlockPos departureTo, relocationRefused;
    private BlockPos fallVolumeFrom;
    private Direction fallVolumeBearing;
    private Box fallVolume;
    private Vec3d aim;
    private Direction preferred, bearing, caveBearing, departureBearing;
    private BlockHitResult departureTop;
    private BlockState departureSurface;
    private AgentSurfaceTread crossing;
    private Foothold foothold;
    private Phase phase, afterLight;
    private boolean litHere, trimmed, cavePending, openTread, departureBacktrack, drift;
    private String relocationRefusal;
    private Face optionFact;
    private final String[] bearingReasons = new String[4];
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
        return active() && (drift || phase == Phase.DRIVE || phase == Phase.RELOCATE
            || buildingFoothold() || checkingReturn());
    }

    boolean surveyingCave() { return active() && cavePending; }

    boolean unjoined() {
        return client.world == world && client.player == player && detachedRim != null;
    }

    /** Abandon the old worksite without admitting any connection to its detached rim. */
    void resited(BlockPos foot) {
        if (client.world != world || client.player != player || active() || !dryGroundAt(foot)) return;
        detachedRim = relocationRefused = null;
        detachedLevel = false;
        relocationRefusal = null;
    }

    String status() { return status; }
    int depth() { return depth; }
    BlockPos witnessedLowCeiling() { return client.player == player && client.world == world ? reverseCeiling : null; }

    boolean hasProgressLease() {
        int now = body.actionTick();
        return continuing(now)
            && (phase == Phase.RELOCATE || phase == Phase.CHOOSE || phase == Phase.OPEN
                || buildingFoothold()
                || crossingConnector()
                || driftSetup(now)
                || progressAt >= started && now - progressAt <= PROGRESS_LEASE_TICKS
                || cavePending && now - caveSince <= CAVE_TURN_LIMIT
                || caveSurveySpent && (phase == Phase.ANCHOR || phase == Phase.CHOOSE)
                    && now - phaseSince < CAVE_TURN_LIMIT);
    }

    boolean hasRetryProgressLease() {
        int now = body.actionTick();
        return continuing(now)
            && (phase == Phase.RELOCATE || buildingFoothold() || crossingConnector() || driftSetup(now) || routeWork.recent(now));
    }

    private boolean buildingFoothold() { return phase == Phase.FOOTHOLD || phase == Phase.FOOTHOLD_RECEIPT; }

    private boolean crossingConnector() { return phase == Phase.DRIVE && foothold != null && foothold.level; }

    // A newly witnessed side face gets a short setup window, not a route receipt.
    private boolean driftSetup(int now) { return drift && now - started <= PROGRESS_LEASE_TICKS; }

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

    boolean gravelCutAvailable() { return gravelWork.canCut(); }

    void observeBreak(BlockPos position, BlockState broken) {
        if (witnessedLowCeiling() != null && reverseCeiling.up(2).equals(position)) reverseCeiling = null;
        if (relocationRefused != null && position.getSquaredDistance(relocationRefused) <= 4)
            relocationRefused = null;
        int now = body.actionTick();
        if (active() && !cavePending && lastTurn == now && position.equals(workCell)
                && position.equals(body.continuityMiningTarget())) {
            if (phase == Phase.CUT) {
                if (broken.isOf(Blocks.GRAVEL)) {
                    gravelWork.broke(now);
                    routeWork.gravelCut(position, now);
                    progressAt = now;
                } else routeWork.cut(position, now);
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
            if (standing.equals(detachedRim) && body.dryCaveContact(standing) != null) {
                detachedRim = null;
                detachedLevel = false;
            }
            this.depth = depth;
            preferred = preference;
            if (standing.equals(relocationRefused)) return finish(Outcome.EXHAUSTED, relocationRefusal);
            if (unjoined() || !loci.fresh(standing))
                return relocateFrom(standing, now, "finding a distinct mine start");
            limit = Math.min(LEG_LIMIT, Math.min(standing.getY() - depth, suppliedSteps(host)));
            if (limit <= 0) return finish(Outcome.SUPPLIES, "keeping a light and tool reserve for the mine return");
            anchor = from = standing.toImmutable();
            bearing = null;
            choice = drops = footholdUses = connectorViews = 0;
            caveMask = 0;
            caveSurveySpent = connectorPeekSpent = false;
            Arrays.fill(bearingReasons, null);
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
            if (buildingFoothold()) return fail(routeFailure("foothold", foothold.cell, "unsafe player conditions"));
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
                    return finish(Outcome.DIVERTED, host.status());
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
        if (now - started >= LEG_TICKS)
            return fail(buildingFoothold() ? routeFailure("foothold", foothold.cell, "mine leg reached its time limit")
                : "returnable mine leg reached its time limit");
        if (phase != Phase.DRIVE && !buildingFoothold() && !dryGroundAt(checkingReturn() ? to : from))
            return fail("lost the committed dry mine stance");
        if ((!settling() || drift && phase != Phase.DRIVE) && bearing != null
                && body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65))
            return fail(routeFailure("bearing", to, "visible lava", checkingReturn()));
        if (bearing != null && phase != Phase.CHOOSE && !settleLane(bearing, now)) return outcome;
        switch (phase) {
            case ANCHOR -> anchor(now);
            case CHOOSE -> choose(host, now);
            case OPEN -> open(host, now);
            case CUT -> cut(host, now);
            case LIGHT -> light(host, now);
            case FORWARD -> prove(host, now, false);
            case FOOTHOLD -> placeFoothold(host, now);
            case FOOTHOLD_RECEIPT -> confirmFoothold(host, now);
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
            optionFact = null;
            begin(Phase.CHOOSE, now);
        } else {
            prepareCut(now);
        }
    }

    private void choose(AgentProgress host, int now) {
        for (; choice < 4; choice++) {
            Direction candidate = option(choice);
            Refusal prior = refusal(from, candidate);
            if (prior != null) { bearingReasons[choice] = prior.reason(); continue; }
            if (body.hazardAhead(candidate.getPositiveHorizontalDegrees(), 1.65)) {
                rejectChoice(candidate, now, Face.LAVA);
                return;
            }
            if (!settleLane(candidate, now)) return;
            if (now - optionSince >= 48) {
                rejectChoice(candidate, now, optionFact == null ? Face.UNSEEN : optionFact);
                return;
            }
            if (aim == null) aimCut(nextTread(candidate), candidate);
            body.aim(aim);
            switch (body.dryCaveSpace(aim)) {
                case CLEAR -> lowerChoice(candidate, now);
                case FLUID -> rejectChoice(candidate, now, Face.FLUID);
                case DARK -> optionFact = Face.DARK;
                case UNKNOWN -> {
                    if (cut == 0 && body.renderedAim(aim, 10)) nextCutSample();
                }
                case OBSTRUCTION -> {
                    double reach = player.getEyePos().distanceTo(aim) + 0.04;
                    BlockHitResult face = body.terrain(aim, reach).orElse(null);
                    if (face == null || !face.getBlockPos().equals(workCell)
                            || cut == 0 && !witnessedCap(workCell, candidate, face)) {
                        optionFact = Face.OCCLUDED;
                        if (cut == 0 && body.renderedAim(aim, 10)) nextCutSample();
                        return;
                    }
                    BlockHitResult contact = body.perceive(aim, reach).orElse(null);
                    boolean exactContact = contact != null && workCell.equals(contact.getBlockPos());
                    BlockState shown = world.getBlockState(workCell);
                    boolean gravel = shown.isOf(Blocks.GRAVEL);
                    Face fact = exactContact ? host.returnableLaneFace(from, candidate, contact, false)
                        : gravel ? Face.OCCLUDED : host.returnableFace(face);
                    if (exactContact && host.handoffReturnableResource(contact)) {
                        finish(Outcome.DIVERTED, "taking exposed ore before cutting a mine leg");
                    } else if (fact != Face.MINEABLE && fact != Face.OCCLUDED) {
                        String detail = gravel || fact == Face.MATERIAL || fact == Face.TOOL
                            ? "mine descent " + candidate + " refused " + Registries.BLOCK.getId(shown.getBlock())
                                + " at " + workCell.toShortString() + ": " + fact
                            : null;
                        rejectChoice(candidate, now, fact, detail);
                    } else if (fact == Face.MINEABLE && exactContact) {
                        bearing = candidate;
                        to = nextTread(candidate);
                        treadEvidence = 0;
                        trimmed = openTread = false;
                        Vec3d contactAim = aim;
                        begin(Phase.CUT, now);
                        aim = contactAim;
                    } else {
                        optionFact = Face.OCCLUDED;
                        if (cut == 0 && body.renderedAim(aim, 10)) nextCutSample();
                    }
                }
            }
            return;
        }
        exhausted(now, refusalSummary());
    }

    private boolean fallingInLane(Direction lane) {
        if (!from.equals(fallVolumeFrom) || lane != fallVolumeBearing) {
            fallVolumeFrom = from;
            fallVolumeBearing = lane;
            int dx = lane.getOffsetX(), dz = lane.getOffsetZ();
            fallVolume = new Box(from.getX() + Math.min(dx, 0), from.getY() - 2, from.getZ() + Math.min(dz, 0),
                from.getX() + 1 + Math.max(dx, 0), from.getY() + 6, from.getZ() + 1 + Math.max(dz, 0));
        }
        // This is only a local veto on a falling entity entering the two exact columns, not a block/height survey.
        world.collectEntitiesByType(FALLING_ENTITIES, fallVolume, FallingBlockEntity::isAlive, fallingBlocks, 1);
        if (fallingBlocks.isEmpty()) return false;
        fallingBlocks.clear();
        return true;
    }

    private boolean settleLane(Direction lane, int now) {
        boolean wasWaiting = gravelWork.waiting();
        Fall fall = gravelWork.settle(now, fallingInLane(lane));
        if (fall == Fall.SETTLED) {
            if (wasWaiting) status = "rechecking the exact " + lane + " mine cells after the fall";
            return true;
        }
        String why = "falling material has not settled in the exact cut and stance";
        if (phase == Phase.DRIVE || fall == Fall.UNSAFE) {
            if (phase == Phase.CHOOSE) rejectChoice(lane, now, Face.UNSETTLED);
            else if (phase == Phase.CUT) refuseGravelCut(now, Face.UNSETTLED, why);
            else fail(routeFailure("falling column", to, why, checkingReturn()));
        } else {
            if (phase == Phase.OPEN || phase == Phase.FORWARD || phase == Phase.REVERSE) {
                proof = floorSample = 0;
                aim = null;
            }
            status = "holding on dry footing while " + lane + " falling material settles";
        }
        return false;
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
        rejectChoice(candidate, now, fact, null);
    }

    private void rejectChoice(Direction candidate, int now, Face fact, String detail) {
        retire(from, candidate, fact, detail);
        bearingReasons[choice] = detail == null ? fact.name() : detail;
        begin(Phase.CHOOSE, now);
        status = detail == null ? "returnable mine refused " + candidate + " down from " + from.toShortString() + ": " + fact
            : detail;
        bearing = null;
        to = null;
        foothold = null;
        revealedFrame = -1;
        routeWork.reset();
        choice++;
        cut = 2;
        cutSample = 0;
        optionFact = null;
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
        if (aim == null) aim = proofFloorAim(to, bearing, floorSample);
        body.aim(aim);
        var top = body.dryRouteTop(aim, to.down(), true);
        if (top == AgentBody.DryRouteTop.FLUID) {
            rejectChoice(bearing, now, Face.FLUID, routeFailure("landing floor", to.down(), "visible fluid"));
            return;
        }
        if (top == AgentBody.DryRouteTop.WITNESSED) {
            if (!body.walkedLaneDry(from, to, bearing)) {
                rejectChoice(bearing, now, Face.NO_EXIT);
                return;
            }
            if (!body.dryRouteSweep(from, to)) {
                if (now - phaseSince >= 28) rejectChoice(bearing, now, Face.NO_EXIT);
                return;
            }
            if (!AgentSurfaceTread.retainedLaneClear(client, from, to, bearing)) {
                if (!AgentSurfaceTread.reverseClear(client, from, to, bearing) && offerOneWayTread(host, now))
                    return;
                rejectChoice(bearing, now, Face.NO_EXIT);
                return;
            }
        } else if (floorSample == 0 || top != AgentBody.DryRouteTop.NO_FULL_TOP || !body.renderedAim(aim, 8)) {
            if (now - phaseSince >= 28) {
                rejectChoice(bearing, now, Face.NO_LANDING, routeFailure("landing floor", to.down(), failedFloor(top)));
            } else if (floorSample == 0 && body.renderedAim(aim, 8)) {
                floorSample = 1;
                aim = null;
            }
            return;
        }
        openTread = true;
        treadEvidence = 0;
        trimmed = false;
        begin(Phase.FORWARD, now);
    }

    private void startFoothold(int now, BlockPos cell) {
        if (footholdUses >= FOOTHOLD_LIMIT) {
            refuseFoothold(now, cell, "the mine leg has used its two placement attempts");
            return;
        }
        BlockState source = body.dryCaveContact(from);
        if (source == null || !insideFooting(from, player.getBoundingBox())) {
            refuseFoothold(now, cell, "no independently stable source footing");
            return;
        }
        int slot = 0;
        while (slot < unresolvedFootholds.length && unresolvedFootholds[slot] != null) slot++;
        if (slot == unresolvedFootholds.length) {
            refuseFoothold(now, cell, "too many earlier uses lack a confirmed placement");
            return;
        }
        foothold = new Foothold(from, bearing, source, slot);
        begin(Phase.FOOTHOLD, now);
    }

    private boolean startLevelConnector(AgentProgress host, Foothold lower, int now) {
        if (connectorViews >= CONNECTOR_VIEWS || unjoined() || host.returnableFootholdStock() <= WORKSHOP_RESERVE
                || body.caveLipFooting(from) != lower.source
                || LEG_TICKS - (now - started) <= CONNECTOR_VIEW_TICKS + CONNECTOR_COMMIT_TICKS) return false;
        BlockPos cell = from.offset(bearing).down();
        if (unresolvedFoothold(cell) || host.returnableFootholdProtected(cell) || protectedCutAttachment(world, cell))
            return false;
        connectorViews++;
        foothold = new Foothold(from, bearing, lower.source, lower.unresolvedSlot, true);
        to = foothold.landing;
        begin(Phase.FOOTHOLD, now);
        return true;
    }

    private void inspectLevelOutlet(AgentProgress host, Foothold build, int now) {
        float yaw = build.bearing.getPositiveHorizontalDegrees();
        body.turnFixed(yaw, AgentBody.LEVEL_ROUTE_PITCH);
        status = "looking for supported passage beyond the possible one-block level connector";
        if (body.renderedDirection(yaw, AgentBody.LEVEL_ROUTE_PITCH, 8) && body.dryRouteHorizonRoom()) {
            // Only the three onward neighbors of this exact bridge, and only in this forward view.
            for (int i = 0; i < 3; i++) {
                Direction onward = i == 0 ? build.bearing
                    : i == 1 ? build.bearing.rotateYClockwise() : build.bearing.rotateYCounterclockwise();
                BlockPos foot = build.landing.offset(onward), floor = foot.down();
                if (unresolvedFoothold(floor)) continue;
                var top = body.dryRouteFloor(proofFloorAim(foot, onward, 1), floor);
                if (top == null || body.dryCaveSpace(Vec3d.ofCenter(foot, 0.22)) != AgentBody.DryRouteSample.CLEAR
                        || body.dryCaveSpace(Vec3d.ofCenter(foot, 1.74)) != AgentBody.DryRouteSample.CLEAR) continue;
                var outlet = witnessedLevelOutlet(build.from, build.landing, top, world.getBlockState(floor),
                    AgentSurfaceTread.retainedLaneClear(client, build.landing, foot, onward));
                if (outlet == null) continue;
                build.outlet = outlet;
                begin(Phase.FOOTHOLD, now);
                return;
            }
        }
        if (now - phaseSince >= CONNECTOR_VIEW_TICKS)
            refuseLevelConnector(host, build, now, "no independently witnessed dry support and passage beyond it");
    }

    static LevelOutlet witnessedLevelOutlet(BlockPos from, BlockPos bridge, BlockHitResult top,
                                           BlockState support, boolean clear) {
        if (!clear || top == null || top.isInsideBlock() || support == null || support.isAir()
                || !AgentBody.normalDryTraction(support)
                || unsafeFootholdNeighbor(support) || !AgentBody.matchesDryRouteTop(top, top.getBlockPos())) return null;
        BlockPos foot = top.getBlockPos().up();
        Direction travel = AgentSurfaceTread.prospectLevelBearing(bridge, foot);
        return foot.equals(from) || foot.getY() != bridge.getY() || travel == null ? null : new LevelOutlet(foot, travel, support);
    }

    private boolean outletStillClear(Foothold build) {
        var outlet = build.outlet;
        return world.getBlockState(outlet.foot.down()) == outlet.support
            && !unsafeFootholdNeighbor(world.getBlockState(outlet.foot))
            && !unsafeFootholdNeighbor(world.getBlockState(outlet.foot.up()))
            && AgentSurfaceTread.retainedLaneClear(client, build.landing, outlet.foot, outlet.travel);
    }

    private void refuseLevelConnector(AgentProgress host, Foothold build, int now, String why) {
        rejectChoice(bearing, now, Face.NO_LANDING, routeFailure("level connector", build.cell, why));
        // Preserve the existing supported shelf fallback, but not through a cell with an unresolved use.
        if (build.issuedFrame < 0 && host.startMineCaveShelf(build.from, build.bearing, AgentDryLanding.MAX_DROP))
            holdCave(host, build.bearing, now);
    }

    private void refuseBuild(AgentProgress host, Foothold build, int now, String why) {
        if (build.level) refuseLevelConnector(host, build, now, why);
        else refuseFoothold(now, build.cell, why);
    }

    private void placeFoothold(AgentProgress host, int now) {
        Foothold build = foothold;
        if (build.level && build.peekSince >= 0 && now - build.peekSince < CONNECTOR_PEEK_TICKS) {
            if (body.caveLipFooting(build.from) != build.source || !insideFooting(build.from, player.getBoundingBox())) {
                fail(routeFailure("level connector", build.cell, "lost grounded, dry peek support"));
                return;
            }
            body.turnFixed(build.bearing.getPositiveHorizontalDegrees(), 70);
            body.driveFootholdPeek(build.from, build.bearing);
            return;
        }
        if (!footholdStance(build)) return;
        int stock = host.returnableFootholdStock();
        var options = client.options;
        if (options.useKey.isUnbound() || options.sneakKey.isUnbound() || options.forwardKey.isUnbound()
                || options.jumpKey.isUnbound() || !player.getOffHandStack().isEmpty() || player.isUsingItem()) {
            refuseBuild(host, build, now, "use or return controls unavailable, off hand occupied, or another item in use");
            return;
        }
        if (host.returnableFootholdProtected(build.cell) || protectedCutAttachment(world, build.cell)) {
            refuseBuild(host, build, now, "the support cell intersects a station, light, or retained return passage");
            return;
        }
        if (body.lavaEmergency() || body.hazardAhead(bearing.getPositiveHorizontalDegrees(), 1.65)) {
            refuseFoothold(now, build.cell, "visible lava vetoes the selected bearing");
            return;
        }
        if (build.level && build.outlet == null) {
            inspectLevelOutlet(host, build, now);
            return;
        }
        boolean expired = now - phaseSince >= FOOTHOLD_CONTACT_TICKS + (build.peekSince >= 0 ? CONNECTOR_PEEK_TICKS : 0);
        Vec3d view = build.anchor == null ? build.low : build.anchor.getPos();
        body.aimFine(view);
        if (!body.hasRecentView() || !body.footholdRaysAvailable()) {
            if (expired) refuseBuild(host, build, now, "not enough current rendered view to prove the air and attachment");
            return;
        }
        var low = body.footholdSpace(build.low);
        var high = body.footholdSpace(build.high);
        if (!Foothold.empty(low, high)) {
            if (expired || low != AgentBody.FootholdSpace.VIEW && high != AgentBody.FootholdSpace.VIEW
                    && body.renderedAim(view, 8))
                refuseBuild(host, build, now, Foothold.spaceRefusal(low, high));
            return;
        }
        if (build.anchor == null) {
            build.anchor = body.visibleFootholdAttachment(build.cell, bearing, build.low, build.high,
                player.getBlockInteractionRange());
            if (build.anchor == null) {
                if (expired || body.renderedAim(view, 8)) {
                    if (build.level) {
                        if (!expired && !connectorPeekSpent) {
                            connectorPeekSpent = true;
                            build.peekSince = now;
                            status = "taking one crouched look for an attaching face without leaving the retained top";
                        } else {
                            refuseLevelConnector(host, build, now, "no visible reachable side or top attaches to it");
                        }
                        return;
                    }
                    if (startLevelConnector(host, build, now)) return;
                    Direction aperture = bearing;
                    refuseFoothold(now, build.cell, "no visible reachable stable top or side can attach to it");
                    // This exact tread was visibly empty. Before changing bearing,
                    // give the supported lip one chance to reveal a different route.
                    if (host.startMineCaveShelf(build.from, aperture, AgentDryLanding.MAX_DROP))
                        holdCave(host, aperture, now);
                }
                return;
            }
            if (stock <= WORKSHOP_RESERVE) {
                refuseBuild(host, build, now, "keeping eight cobblestone for the workshop");
                return;
            }
            build.anchorState = world.getBlockState(build.anchor.getBlockPos());
            body.aimFine(build.anchor.getPos());
            status = "aligning one witnessed cobblestone attachment for " + build.cell.toShortString();
            return;
        }
        String refusal = build.placementRefusal(player.getBoundingBox(), stock,
            !world.getOtherEntities(player, build.volume).isEmpty(), low, high, build.anchor);
        if (refusal == null) refusal = footholdHazard(build.cell);
        if (refusal == null && (!body.dryRouteBuildClear(from, to)
                || !(build.level ? AgentSurfaceTread.retainedLaneClear(client, from, to, bearing) && outletStillClear(build)
                    : AgentSurfaceTread.reverseClear(client, from, to, bearing))))
            refusal = build.level ? "the level crossing, reverse passage, or onward shelf is blocked"
                : "the exact tread lacks a clear body sweep or reverse jump";
        if (refusal != null) {
            refuseBuild(host, build, now, refusal);
            return;
        }
        if (world.getBlockState(build.anchor.getBlockPos()) != build.anchorState) {
            refuseBuild(host, build, now, "the witnessed attaching face changed before use");
            return;
        }
        if (expired) {
            refuseBuild(host, build, now, "the witnessed attaching face did not settle for vanilla use");
            return;
        }
        int reserve = build.level ? CONNECTOR_COMMIT_TICKS : FOOTHOLD_RECEIPT_TICKS + PROGRESS_LEASE_TICKS;
        if (LEG_TICKS - (now - started) <= reserve) {
            refuseBuild(host, build, now, "not enough time remains to recheck the placement and return");
            return;
        }
        boolean ready = host.equipReturnableFoothold();
        body.sneak();
        var preparation = ready && !player.isSneaking() ? AgentBody.Preparation.STANCE : AgentBody.Preparation.equipment(ready);
        if (body.placeFoothold(build.anchor, build.cell, preparation)) {
            footholdUses++;
            if (build.level) connectorViews = CONNECTOR_VIEWS;
            build.issued(body.renderedFrame(), stock);
            unresolvedFootholds[build.unresolvedSlot] = build.cell;
            begin(Phase.FOOTHOLD_RECEIPT, now);
        }
    }

    private void confirmFoothold(AgentProgress host, int now) {
        Foothold build = foothold;
        if (!footholdStance(build)) return;
        int stock = host.returnableFootholdStock();
        long frame = body.renderedFrame();
        if (aim == null) aim = proofFloorAim(to, bearing, 0);
        body.aim(aim);
        if (build.debited(stock) && frame > build.issuedFrame) {
            BlockHitResult top = body.dryRouteFloor(aim, build.cell);
            if (top == null) top = body.dryRouteFloor(proofFloorAim(to, bearing, 1), build.cell);
            if (top != null && build.confirms(frame, top, world.getBlockState(build.cell), stock)) {
                unresolvedFootholds[build.unresolvedSlot] = null;
                if (build.level) {
                    var edge = witnessedTransit(from, to, bearing, top, build.source, world.getBlockState(build.cell),
                        body.dryRouteSweep(from, to) && body.walkedLaneDry(from, to, bearing)
                            && AgentSurfaceTread.retainedLaneClear(client, from, to, bearing) && outletStillClear(build));
                    if (edge == null) {
                        refuseLevelConnector(host, build, now, "the installed top did not leave a clear reversible level route");
                        return;
                    }
                    crossing = AgentSurfaceTread.witnessedOutbound(edge, now);
                    begin(Phase.DRIVE, now);
                    status = "confirmed the attached cobblestone; walking the checked level connector";
                    return;
                }
                routeWork.support(now);
                progressAt = now;
                openTread = true;
                begin(Phase.FORWARD, now);
                status = "confirmed one attached cobblestone at " + build.cell.toShortString()
                    + "; rechecking the dry tread before moving";
                return;
            }
        }
        if (now - phaseSince >= FOOTHOLD_RECEIPT_TICKS)
            refuseBuild(host, build, now, !build.debited(stock)
                ? "one use did not show an exact one-block debit"
                : "one debit was seen, but no fresh full cobblestone top at that cell");
    }

    private boolean footholdStance(Foothold build) {
        if (dryGroundAt(build.from) && !player.getAbilities().flying
                && player.getVelocity().horizontalLengthSquared() <= 0.0025
                && insideFooting(build.from, player.getBoundingBox())
                && (build.level ? body.caveLipFooting(build.from) : body.dryCaveContact(build.from)) == build.source)
            return true;
        fail(routeFailure("foothold", build.cell, "lost the independent settled dry stance"));
        return false;
    }

    /** Negative-only checks of the selected cell's neighbors and the exact two tread columns. */
    private String footholdHazard(BlockPos cell) {
        for (Direction side : ADJACENT) {
            var neighbor = footholdProbe.set(cell).move(side);
            if (unsafeFootholdNeighbor(world.getBlockState(neighbor)))
                return "fluid, falling material, or hazardous block beside the support at " + neighbor.toShortString();
        }
        for (int y = 0; y <= 2; y++) {
            if (unsafeFootholdNeighbor(world.getBlockState(footholdProbe.set(from).move(Direction.UP, y)))
                    || unsafeFootholdNeighbor(world.getBlockState(footholdProbe.set(to).move(Direction.UP, y))))
                return "fluid, falling material, or a hazardous block in the exact tread at " + footholdProbe.toShortString();
        }
        return null;
    }

    private static boolean unsafeFootholdNeighbor(BlockState shown) {
        return AgentBody.dryCaveDanger(shown) || shown.getBlock() instanceof FallingBlock;
    }

    private void refuseFoothold(int now, BlockPos cell, String why) {
        rejectChoice(bearing, now, Face.NO_LANDING, routeFailure("foothold", cell, why));
    }

    private boolean unresolvedFoothold(BlockPos cell) {
        for (BlockPos unresolved : unresolvedFootholds) if (cell.equals(unresolved)) return true;
        return false;
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

    private boolean offerOneWayTread(AgentProgress host, int now) {
        Direction aperture = bearing;
        if (!host.startMineCaveShelf(from, aperture, 1)) return false;
        rejectChoice(aperture, now, Face.NO_EXIT, routeFailure("return headroom", to, "no verified reverse grade"));
        holdCave(host, aperture, now);
        return true;
    }

    private void prepareCut(int now) {
        to = nextTread(bearing);
        cut = 2;
        cutSample = 0;
        treadEvidence = 0;
        trimmed = openTread = false;
        begin(Phase.CUT, now);
    }

    private void cut(AgentProgress host, int now) {
        if (now - phaseSince >= 150) {
            fail(drift ? routeFailure("side cut", workCell, "contact was not confirmed")
                : "could not clear the next returnable mine tread");
            return;
        }
        if (!center(from)) return;
        if (drift && body.dryCaveContact(from) == null) {
            fail("lost independent dry footing for the side cut");
            return;
        }
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
        if (cut == 0 && !drift) {
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
                    if (body.dryCaveContact(from) == null ||
                            !stationaryCap(from, workCell, bearing, player.getBoundingBox())) {
                        fail("the visible mine cap cannot be opened from independent, settled footing");
                        return;
                    }
                }
            }
        }
        switch (host.clearReturnableLane(from, workCell, bearing, aim, drift)) {
            case CLEAR -> {
                aim = null;
                if (--cut < 0) {
                    if (drift && (treadEvidence & 1) == 0)
                        fail(routeFailure("side cut", workCell, "no confirmed cut of the natural foot block"));
                    else begin(Phase.FORWARD, now);
                }
            }
            case DARK -> needLight(host, now);
            case FALLING_COVER -> refuseGravelCut(now, Face.FALLING_COVER, "visible falling material still covers the face");
            case GRAVEL_LIMIT -> refuseGravelCut(now, Face.GRAVEL_LIMIT, "three confirmed gravel breaks did not open the tread");
            case BLOCKED, LIP -> fail(drift ? routeFailure("side cut", workCell, "unsafe or protected face")
                : "a witnessed obstruction refused the returnable mine cut");
            case RESOURCE -> finish(Outcome.DIVERTED, "taking exposed ore before cutting further");
            case LOOKING -> {}
        }
    }

    private void refuseGravelCut(int now, Face fact, String reason) {
        String detail = routeFailure("cut", workCell, reason);
        if (drift) fail(detail);
        else rejectChoice(bearing, now, fact, detail);
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
        boolean expired = now - phaseSince >= 83;
        if (!center(source)) {
            if (expired) fail(routeFailure("settled stance", source, "body did not center", reverse));
            return;
        }
        if (reverse && trimmed && proof > CLEARANCE_HEIGHTS.length * 2) {
            if (expired) fail(routeFailure("repaired passage", to, "recheck did not complete", true));
            else recheckForward(host, now);
            return;
        }
        int samples = (drift ? CLEARANCE_HEIGHTS.length - 1 : CLEARANCE_HEIGHTS.length) * 2;
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
            var sample = drift ? body.dryCaveSpace(aim) : body.dryRouteClear(aim);
            boolean cannotLight = sample == AgentBody.DryRouteSample.DARK
                && (litHere || host.returnableTorches() <= TORCH_RESERVE) && body.renderedAim(aim, 14);
            if (!reverse && !drift && foothold == null && proof >= (CLEARANCE_HEIGHTS.length - 1) * 2
                    && (sample == AgentBody.DryRouteSample.OBSTRUCTION && body.renderedAim(aim, 10)
                        || expired && sample == AgentBody.DryRouteSample.UNKNOWN)
                    && offerOneWayTread(host, now)) return;
            if (sample != AgentBody.DryRouteSample.CLEAR && (expired || sample == AgentBody.DryRouteSample.FLUID
                    || cannotLight)) {
                String side = (proof & 1) == 0 ? "right" : "left";
                refuseTread(now, reverse, routeFailure("clearance " + CLEARANCE_HEIGHTS[proof / 2] + "m " + side,
                    BlockPos.ofFloored(aim), sample == AgentBody.DryRouteSample.UNKNOWN ? unknownSample(aim) : sample.name(),
                    reverse));
                return;
            }
            if (sample == AgentBody.DryRouteSample.CLEAR) {
                checkedEvidence((reverse ? 12 : 3) + proof, now);
                proof++;
                aim = null;
            } else if (sample == AgentBody.DryRouteSample.DARK) {
                if (body.renderedAim(aim, 14)) needLight(host, now);
            } else if (reverse && !openTread && proof >= 4 && body.renderedAim(aim, 14)) {
                considerReturnTrim(host, now);
            }
            return;
        }
        if (aim == null) aim = proofFloorAim(target, direction, floorSample);
        body.aim(aim);
        BlockPos floor = target.down();
        if (!reverse && unresolvedFoothold(floor)) {
            String why = "an earlier use at this cell never produced a confirmed placement";
            if (drift) fail(routeFailure("foothold", floor, why));
            else refuseFoothold(now, floor, why);
            return;
        }
        var top = body.dryRouteTop(aim, floor, true);
        if (top != AgentBody.DryRouteTop.WITNESSED) {
            if (top == AgentBody.DryRouteTop.FLUID) {
                refuseTread(now, reverse, routeFailure("landing floor", floor, "visible fluid", reverse));
            } else if (top == AgentBody.DryRouteTop.DARK && !expired && !litHere
                    && body.renderedAim(aim, 14) && host.returnableTorches() > TORCH_RESERVE) {
                needLight(host, now);
            } else if (top == AgentBody.DryRouteTop.OCCLUDED || top == AgentBody.DryRouteTop.NO_FULL_TOP
                    || top == AgentBody.DryRouteTop.UNSUITABLE_TOP || top == AgentBody.DryRouteTop.DARK) {
                if (floorSample == 0 && !expired && body.renderedAim(aim, 8)) {
                    floorSample = 1;
                    aim = null;
                } else if (expired || body.renderedAim(aim, 8)) {
                    if (!reverse && !drift && !expired && top == AgentBody.DryRouteTop.NO_FULL_TOP
                            && foothold == null) {
                        startFoothold(now, floor);
                    } else {
                        refuseTread(now, reverse, routeFailure("landing floor", floor, failedFloor(top), reverse));
                    }
                }
            } else if (expired) {
                refuseTread(now, reverse, routeFailure("landing floor", floor, failedFloor(top), reverse));
            }
            return;
        }
        if (!reverse && foothold != null && !world.getBlockState(floor).isOf(Blocks.COBBLESTONE)) {
            refuseFoothold(now, floor, "the installed cobblestone changed before the tread recheck");
            return;
        }
        var veto = body.dryRouteVeto(source, target);
        if (veto != AgentBody.DryRouteVeto.CLEAR) {
            if (expired || veto == AgentBody.DryRouteVeto.HAZARD || veto == AgentBody.DryRouteVeto.SUPPORT) {
                String reason = switch (veto) {
                    case VIEW -> "no recent first-person frame";
                    case HAZARD -> "live hazard veto";
                    case DRIFT -> "body was outside the tread bounds";
                    case SUPPORT -> "source or landing lost load-bearing contact";
                    case SWEEP -> "collision in the exact tread volume";
                    case CLEAR -> throw new IllegalStateException("clear sweep cannot be refused");
                };
                refuseTread(now, reverse, routeFailure("body sweep", target, reason, reverse));
            }
            return;
        }
        if (!body.walkedLaneDry(source, target, direction)) {
            refuseTread(now, reverse, routeFailure("dry columns", target, "unsafe block or changed return lane", reverse));
            return;
        }
        if (!reverse && !drift && !AgentSurfaceTread.reverseClear(client, source, target, direction)
                && foothold == null && offerOneWayTread(host, now)) return;
        if (!reverse && openTread && !AgentSurfaceTread.retainedLaneClear(client, source, target, direction)) {
            refuseTread(now, false, routeFailure("dry columns", target, "unsafe block or changed return lane"));
            return;
        }
        if (drift) {
            var floorHit = body.dryRouteFloor(aim, floor);
            if (floorHit != null) {
                // Same-level standing clearance is symmetric. The grounded source
                // and freshly seen destination supply the exact two return supports.
                var edge = witnessedTransit(source, target, direction, floorHit, body.dryCaveContact(source),
                    world.getBlockState(floor), AgentSurfaceTread.retainedLaneClear(client, source, target, direction));
                if (edge != null) {
                    crossing = AgentSurfaceTread.witnessedOutbound(edge, now);
                    checkedEvidence(11, now);
                    begin(Phase.DRIVE, now);
                    return;
                }
            }
            if (expired) fail(routeFailure("level return", target, "exact supports or reverse passage no longer hold"));
            return;
        }
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

    private void refuseTread(int now, boolean reverse, String reason) {
        if (!reverse && !drift && openTread) rejectChoice(bearing, now, Face.NO_LANDING, reason);
        else fail(reason);
    }

    private String failedFloor(AgentBody.DryRouteTop top) {
        return (floorSample == 0 ? "far sample: " : "inner sample: ") + top
            + (top == AgentBody.DryRouteTop.OCCLUDED || top == AgentBody.DryRouteTop.UNSUITABLE_TOP
                || top == AgentBody.DryRouteTop.OUT_OF_VIEW
                ? " (" + unknownSample(aim) + ")" : "");
    }

    private String unknownSample(Vec3d point) {
        if (!body.hasRecentView()) return "no recent first-person frame";
        if (!body.dryRoutePointInView(point)) return "outside the rendered view";
        if (body.dryRouteRaysSpent()) return "no view-ray budget remaining";
        BlockHitResult hit = body.terrain(point, player.getEyePos().distanceTo(point) + 0.04).orElse(null);
        return hit == null ? "no lit clearance witness"
            : "first hit " + hit.getBlockPos().toShortString() + " (" + hit.getSide() + ")";
    }

    private String routeFailure(String sample, BlockPos cell, String reason) {
        return routeFailure(sample, cell, reason, false);
    }

    private String routeFailure(String sample, BlockPos cell, String reason, boolean reverse) {
        return (foothold != null && foothold.level ? "level passage" : drift ? "level drift" : reverse ? "mine return" : "mine descent") + " "
            + (reverse ? bearing.getOpposite() : bearing) + " refused " + sample + " at "
            + (cell == null ? "unselected cell" : cell.toShortString()) + ": " + reason;
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
        driftAttempts = 0;
        if (++drops == limit) {
            finish(Outcome.REACHED, "reached " + drops + " lower dry mine treads with verified return edges");
        } else {
            from = to;
            to = null;
            preferred = bearing;
            choice = 0;
            Arrays.fill(bearingReasons, null);
            caveMask = 0;
            caveSurveySpent = false;
            begin(Phase.ANCHOR, now);
        }
    }

    private void drive(AgentProgress host, int now) {
        if (drift || crossingConnector()) {
            switch (crossing.step(client, body, now)) {
                case CHECKING -> { }
                case MOVING -> host.rememberReturnableMotion();
                case REFUSED -> fail(routeFailure("level crossing", to, crossing.refusal()));
                case LANDED -> {
                    if (crossingConnector()) {
                        landedConnector(host, now);
                        return;
                    }
                    host.recordReturnableRelocation(from, to, bearing);
                    preferred = bearing;
                    anchor = from = to;
                    to = null;
                    bearing = null;
                    crossing = null;
                    drift = false;
                    choice = drops = caveMask = footholdUses = 0;
                    caveSurveySpent = false;
                    Arrays.fill(bearingReasons, null);
                    limit = Math.min(LEG_LIMIT, Math.min(from.getY() - depth, suppliedSteps(host)));
                    if (limit <= 0) {
                        finish(Outcome.SUPPLIES, "reached a new level mine footing; keeping the return supplies");
                        return;
                    }
                    started = progressAt = now;
                    begin(Phase.ANCHOR, now);
                    status = "reached a new level mine footing; checking a fresh descending bearing";
                }
            }
            return;
        }
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

    private void landedConnector(AgentProgress host, int now) {
        if (!to.down().equals(player.supportingBlockPos.orElse(null)) || crossing.rememberedLaneChanged(client, body)) {
            fail(routeFailure("level connector", to, "actual ground contact or the retained return changed"));
            return;
        }
        host.recordReturnableRelocation(from, to, bearing);
        from = to;
        if (from.equals(foothold.landing)) {
            // The far shelf was seen before use. The ordinary motor must now
            // reobserve it from the real connector before taking the next step.
            var outlet = foothold.outlet;
            to = outlet.foot;
            bearing = outlet.travel;
            crossing = new AgentSurfaceTread(new AgentSurfaceTread.Edge(from, crossing.edge.lowerSupport(),
                to, outlet.support, bearing), false, now);
            status = "landed on the reversible level connector; rechecking the seen onward shelf";
            return;
        }
        preferred = bearing;
        to = null;
        bearing = null;
        crossing = null;
        choice = caveMask = 0;
        caveSurveySpent = false;
        Arrays.fill(bearingReasons, null);
        begin(Phase.ANCHOR, now);
        status = "reached the witnessed onward shelf without a descent";
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
        foothold = null;
        drift = false;
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
        driftFaces = 0;
        clearDeparture(now);
    }

    private void clearDeparture(int now) {
        departureSince = now;
        departureTo = null;
        departureTop = null;
        departureSurface = null;
    }

    private void depart(AgentProgress host, int now) {
        if (crossing != null) {
            if (fallingInLane(departureBearing)) {
                crossing = null;
                if (dryGroundAt(from) && !departureBacktrack) clearDeparture(now);
                else relocationFailed("falling material interrupted the checked relocation");
                return;
            }
            switch (crossing.step(client, body, now)) {
                case CHECKING -> { }
                case MOVING -> host.rememberReturnableMotion();
                case LANDED -> {
                    BlockPos landing = crossing.to;
                    host.recordReturnableRelocation(from, landing, departureBearing);
                    if (detachedRim != null && (landing.equals(detachedRim)
                            || !detachedLevel && landing.getY() >= detachedRim.getY())) {
                        detachedRim = null;
                        detachedLevel = false;
                    }
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
        if (hopCount >= RELOCATION_HOPS) {
            relocationFailed("the checked relocation reached its walking limit without a distinct dry start");
            return;
        }
        if (!dryGroundAt(from)) {
            relocationFailed("lost the grounded footing for mine relocation");
            return;
        }
        if (!center(from)) return;
        if (departureTo == null && !nextDeparture(host, now)) {
            if (driftAttempts < DRIFT_LIMIT && !unjoined() && startDrift(host, now)) return;
            if (pathSize > 1 && selectDeparture(searchPath[pathSize - 2], now)) {
                departureBacktrack = true;
                return;
            }
            relocationFailed("no further safe opening, grounded level tread, or one-block rise was proved");
            return;
        }
        Direction lane = departureBearing;
        if (!body.hazardAhead(lane.getPositiveHorizontalDegrees(), 1.65) && !fallingInLane(lane)) {
            var edge = observeDeparture(now);
            if (edge != null) {
                crossing = from.getY() == departureTo.getY() ? AgentSurfaceTread.witnessedOutbound(edge, now)
                    : AgentSurfaceTread.ordinaryGrade(edge, from, now);
                status = from.getY() < departureTo.getY() ? "climbing to a witnessed dry top with clear headroom"
                    : "following a witnessed dry tread away from the exhausted mine start";
                return;
            }
            if (now - departureSince < DEPARTURE_VIEW_TICKS) return;
            noteDriftFace(host, lane);
            // Upward or level travel wins over a sky/air cue. Offer a cave only
            // when this bearing really exposes space below the retained footing.
            BlockPos lower = from.offset(lane).down();
            Vec3d opening = offset(Vec3d.ofCenter(lower, 0.83), lane, 0.37);
            if (!unjoined() && !departureBacktrack && driftFaces == 0 && !unresolvedFoothold(departureTo.down())
                    && body.dryCaveSpace(opening) == AgentBody.DryRouteSample.CLEAR
                    && offerCave(host, lower, lane, now)) return;
        }
        if (!departureBacktrack) clearDeparture(now);
        else relocationFailed("could not reverify the last dry tread to try a different relocation bearing");
    }

    private boolean nextDeparture(AgentProgress host, int now) {
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
            if (seenDuringRelocation(candidate)) continue;
            if (selectDeparture(candidate, now)) return true;
        }
        return false;
    }

    private void noteDriftFace(AgentProgress host, Direction lane) {
        if (unjoined() || driftAttempts == DRIFT_LIMIT || departureBacktrack || departureTo.getY() != from.getY()
                || triedDrift(departureTo) || unresolvedFoothold(departureTo.down()) || body.dryCaveContact(from) == null) return;
        Refusal prior = refusal(from, lane);
        if (prior != null && (prior.fact == Face.FLUID || prior.fact == Face.LAVA || prior.fact == Face.UNSETTLED)) return;
        // A player standing on independent ground can open a side wall at either
        // height. The old trail is not the floor of the proposed new passage.
        for (int height = 1; height >= 0; height--) {
            BlockPos cell = height == 0 ? departureTo : departureTo.up();
            Vec3d point = driftCutAim(cell, lane, height == 1);
            BlockHitResult hit = body.perceive(point, player.getEyePos().distanceTo(point) + 0.04).orElse(null);
            if (hit != null && cell.equals(hit.getBlockPos())) {
                BlockState shown = world.getBlockState(cell);
                if (!AgentBody.dryCaveDanger(shown) && shown.getCollisionShape(world, cell).isEmpty()) continue;
                if (host.returnableLaneFace(from, lane, hit, true) == Face.MINEABLE)
                    driftFaces |= 1 << lane.ordinal();
                break;
            }
        }
    }

    private boolean startDrift(AgentProgress host, int now) {
        for (int i = 0; i < 4; i++) {
            Direction lane = option(i);
            int bit = 1 << lane.ordinal();
            if ((driftFaces & bit) == 0) continue;
            driftFaces &= ~bit;
            BlockPos target = from.offset(lane);
            if (triedDrift(target) || body.hazardAhead(lane.getPositiveHorizontalDegrees(), 1.65) || fallingInLane(lane)
                    || body.dryCaveContact(from) == null) continue;
            if (suppliedSteps(host) <= 0) {
                finish(Outcome.SUPPLIES, "keeping the light and tool reserve before opening a level mine passage");
                return true;
            }
            driftTargets[driftAttempts++] = target.asLong();
            driftSearchStarted = started;
            started = now;
            anchor = from;
            drift = true;
            crossing = null;
            bearing = lane;
            to = target;
            cut = 1;
            treadEvidence = 0;
            litHere = trimmed = openTread = false;
            pendingLight = null;
            routeWork.reset();
            gravelWork.reset();
            begin(Phase.CUT, now);
            return true;
        }
        return false;
    }

    private boolean triedDrift(BlockPos target) {
        long packed = target.asLong();
        for (int i = 0; i < driftAttempts; i++) if (driftTargets[i] == packed) return true;
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
        if (unresolvedFoothold(support)) {
            departureSince = now - DEPARTURE_VIEW_TICKS;
            return null;
        }
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

    static AgentSurfaceTread.Edge witnessedTransit(BlockPos from, BlockPos to, Direction lane, BlockHitResult top,
                                                  BlockState source, BlockState landing, boolean clear) {
        if (!clear || top == null || top.isInsideBlock() || source == null || landing == null
                || AgentBody.dryCaveDanger(source) || AgentBody.dryCaveDanger(landing)
                || source.getBlock() instanceof FallingBlock || landing.getBlock() instanceof FallingBlock
                || !AgentBody.matchesDryRouteTop(top, to.down())
                || !AgentSurfaceTread.cardinalTread(from, to, lane)) return null;
        return from.getY() == to.getY() ? new AgentSurfaceTread.Edge(from, source, to, landing, lane)
            : AgentSurfaceTread.witnessedGradeEdge(from, source, lane, top, landing, clear);
    }

    private static Vec3d floorAim(BlockPos foot, Direction lane) {
        return offset(Vec3d.ofBottomCenter(foot), lane, 0.42).add(0, -0.032, 0);
    }

    static Vec3d proofFloorAim(BlockPos foot, Direction lane, int sample) {
        // A different ray to the same expected full top, never a different support.
        return offset(Vec3d.ofBottomCenter(foot), lane, sample == 0 ? 0.34 : 0.12).add(0, -0.035, 0);
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
        proof = floorSample = 0;
        aim = null;
        if (next == Phase.ANCHOR || next == Phase.CHOOSE || next == Phase.RELOCATE) gravelWork.reset();
        if (next == Phase.ANCHOR) {
            litHere = false;
            pendingLight = null;
            foothold = null;
            routeWork.reset();
        }
        status = switch (next) {
            case ANCHOR -> "checking the stable dry anchor for a returnable mine leg";
            case CHOOSE -> "looking for a witnessed mine face on a safe bearing";
            case OPEN -> "no obstruction to cut; looking for the exact dry landing of the opening";
            case CUT -> drift ? "opening one witnessed face of a level mine passage"
                : "clearing one witnessed cell of the returnable mine stair";
            case LIGHT -> "lighting the dry mine tread from stable support";
            case FORWARD -> drift ? "checking the opened level passage, landing and return"
                : "checking the next dry mine tread and its jump clearance";
            case FOOTHOLD -> "checking lit air and a reachable attachment at " + foothold.cell.toShortString();
            case FOOTHOLD_RECEIPT -> "checking the actual cobblestone top and one-block debit at " + foothold.cell.toShortString();
            case DRIVE -> drift || crossingConnector() ? "walking onto the witnessed level mine footing"
                : "walking onto the witnessed dry mine tread";
            case REVERSE -> "checking the reverse climb from the grounded mine tread";
            case TRIM_RETURN -> "clearing one witnessed block from the known reverse climb";
            case RELOCATE -> "looking for a distinct dry mine start";
        };
    }

    private Outcome fail(String detail) {
        int now = body.actionTick();
        markUnjoined();
        if (drift && dryGroundAt(from) && !unjoined() && player.hurtTime == 0
                && !player.isOnFire() && !player.hasVehicle()) {
            drift = false;
            started = driftSearchStarted;
            bearing = null;
            crossing = null;
            pendingLight = null;
            revealedFrame = -1;
            begin(Phase.RELOCATE, now);
            status = detail;
            return outcome;
        }
        if (!drift && bearing != null) {
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
        boolean level = phase == Phase.DRIVE && (drift || crossingConnector());
        if (active() && (phase == Phase.DRIVE || checkingReturn()) && (player.getY() < from.getY() - 0.055
                || level && crossing.inFlight() && !player.getBlockPos().equals(from))) {
            detachedRim = from;
            detachedLevel = level;
        }
    }

    private Outcome finish(Outcome result, String detail) {
        phase = null;
        cavePending = false;
        drift = false;
        anchor = from = to = workCell = null;
        crossing = null;
        foothold = null;
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
        drift = false;
        driftAttempts = 0;
        detachedLevel = false;
        detachedRim = reverseCeiling = relocationRefused = null;
        relocationRefusal = null;
        pendingLight = null;
        foothold = null;
        equipmentJob = 0;
        revealedFrame = -1;
        Arrays.fill(retired, null);
        Arrays.fill(unresolvedFootholds, null);
        retiredCursor = 0;
        loci.clear();
    }

    private Refusal refusal(BlockPos foot, Direction direction) {
        for (Refusal refusal : retired)
            if (refusal != null && refusal.bearing == direction && refusal.foot.equals(foot)) return refusal;
        return null;
    }

    private void retire(BlockPos foot, Direction direction, Face fact) {
        retire(foot, direction, fact, null);
    }

    private void retire(BlockPos foot, Direction direction, Face fact, String detail) {
        if (foot != null && refusal(foot, direction) == null)
            retired[retiredCursor++ % retired.length] = new Refusal(foot, direction, fact, detail);
    }

    private String refusalSummary() {
        StringBuilder summary = new StringBuilder("no verified descending bearing: ");
        for (int i = 0; i < bearingReasons.length; i++) {
            if (i > 0) summary.append(", ");
            summary.append(option(i)).append('=').append(bearingReasons[i]);
        }
        return summary.toString();
    }

    private void aimCut(BlockPos foot, Direction direction) {
        workCell = foot.up(cut);
        aim = drift ? driftCutAim(workCell, direction, cut == 1)
            : cut == 0 ? capAim(workCell, direction, cutSample) : Vec3d.ofCenter(workCell);
    }

    static Vec3d driftCutAim(BlockPos cell, Direction bearing, boolean head) {
        // Aim low and near the front of the foot block: from standing eye
        // height a ray to its center can first intercept the solid head block.
        return head ? Vec3d.ofCenter(cell) : offset(Vec3d.ofCenter(cell, 0.26), bearing, -0.28);
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

    /** Opening the adjacent column is stationary; FORWARD must separately prove a tread before any step. */
    static boolean stationaryCap(BlockPos foot, BlockPos cap, Direction bearing, Box hull) {
        return bearing.getOffsetY() == 0 && cap.getX() == foot.getX() + bearing.getOffsetX()
            && cap.getZ() == foot.getZ() + bearing.getOffsetZ() && cap.getY() == foot.getY() - 1
            && insideFooting(foot, hull);
    }

    static Face lateralGravelFace(BlockView world, BlockPos foot, Direction bearing, BlockHitResult hit,
                                  Box hull, BlockState support, Vec3d eye, double reach, boolean drift) {
        if (support == null || support.getBlock() instanceof FallingBlock
                || AgentBody.dryCaveDanger(support) || !insideFooting(foot, hull)) return Face.FOOTPRINT;
        if (hit == null || bearing.getOffsetY() != 0 || hit.getType() != HitResult.Type.BLOCK || hit.isInsideBlock()
                || hit.getPos().squaredDistanceTo(eye) > reach * reach) return Face.OCCLUDED;
        BlockPos cell = hit.getBlockPos();
        int height = cell.getY() - foot.getY();
        if (cell.getX() != foot.getX() + bearing.getOffsetX() || cell.getZ() != foot.getZ() + bearing.getOffsetZ()
                || height < (drift ? 0 : -1) || height > 1) return Face.FOOTPRINT;
        if (hit.getSide() != bearing.getOpposite() && !AgentBody.matchesDryRouteTop(hit, cell)) return Face.OCCLUDED;
        if (!world.getBlockState(cell).isOf(Blocks.GRAVEL)) return Face.MATERIAL;
        return protectedCutAttachment(world, cell) ? Face.PROTECTED : Face.MINEABLE;
    }

    static Face gravelCover(BlockView world, BlockPos cell, BlockHitResult hit) {
        if (hit == null || hit.getType() != HitResult.Type.BLOCK) return null;
        BlockPos above = hit.getBlockPos();
        if (above.getX() != cell.getX() || above.getZ() != cell.getZ() || above.getY() != cell.getY() + 1) return null;
        BlockState shown = world.getBlockState(above);
        if (!shown.getFluidState().isEmpty()) return Face.FLUID;
        if (shown.getBlock() instanceof FallingBlock) return Face.FALLING_COVER;
        return AgentBody.dryCaveDanger(shown) ? Face.MATERIAL : null;
    }

    static boolean stationaryDriftCut(BlockView world, BlockPos foot, BlockPos cell, Direction bearing,
                                      BlockHitResult hit, Box hull) {
        if (!AgentSurfaceTread.prospectLevelCell(foot, cell, bearing) || !insideFooting(foot, hull)
                || hit == null || hit.getType() != HitResult.Type.BLOCK || hit.isInsideBlock()
                || !cell.equals(hit.getBlockPos()) || hit.getSide() != bearing.getOpposite()) return false;
        BlockState shown = world.getBlockState(cell); // The exact witnessed face, never beyond it.
        return !AgentBody.dryCaveDanger(shown) && (shown.isIn(BlockTags.BASE_STONE_OVERWORLD)
            || shown.isIn(BlockTags.DIRT)) && !protectedCutAttachment(world, cell);
    }

    private static boolean insideFooting(BlockPos foot, Box hull) {
        return hull.minX >= foot.getX() && hull.maxX <= foot.getX() + 1.0
            && hull.minZ >= foot.getZ() && hull.maxZ <= foot.getZ() + 1.0;
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
