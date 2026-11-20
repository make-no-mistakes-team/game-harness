package io.gameharness.survival;

import io.gameharness.survival.AgentRouteGraph.Retirement;
import java.util.EnumSet;
import java.util.function.BiConsumer;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.EntityPose;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** Observes from the real cave stance; only Body can drive the next selected edge. */
final class AgentDryCaveRoute {
    private static final int VIEW_TICKS = 51, DRIVE_TICKS = 23;
    private static final int OFFER_FRESH_TICKS = 24, OFFER_MAX_TICKS = 1200;
    private static final int FORWARD = 0x7f, RETURN = 0x180, COMPLETE = FORWARD | RETURN;
    record Offer(BlockPos from, BlockPos next, BlockPos endpoint, int edges) {
        int heightChange() { return endpoint.getY() - from.getY(); }
    }
    static final class Survey {
        private final BlockPos from, to;
        private final Direction bearing;
        private final BlockHitResult witness;

        private Survey(BlockPos from, BlockPos to, Direction bearing, BlockHitResult witness) {
            this.from = from;
            this.to = to;
            this.bearing = bearing;
            this.witness = witness;
        }
    }
    enum SurveyResult { RUNNING, PAIRED, UNPROVED, REFUSED }
    enum DirectResult { RUNNING, ARRIVED, REFUSED }

    private final MinecraftClient client;
    private final AgentBody body;
    private final BiConsumer<BlockPos, BlockPos> reached;
    private final AgentRouteGraph graph = new AgentRouteGraph();
    private final Probe[] candidates = new Probe[3];
    private final Probe[] passive = new Probe[3];
    private final Predicate<BlockState> drySurveyBlock = state -> !state.isAir() && state.getFluidState().isEmpty();
    private final Predicate<BlockHitResult> drySurveyFace = this::visibleLowerFace;
    private final long[] offeredHops = new long[8];
    private ClientWorld world;
    private ClientPlayerEntity player;
    private Direction basis, bearing, unprovedBearing, lightBearing;
    private BlockPos anchor, contact, viewAt, endpoint, limitedAt, unprovedAt, lightAt;
    private Direction contactBearing;
    private Vec3d lastFeet, lastDriveFeet;
    private long lastContactTick, lastPoseTick, surveyEvidence;
    private int viewIndex, viewAdmissions, completedViewTick = -1000, since, lastTurn, centerSince, movingContacts;
    private int missingDriveViews;
    private int missingDirectViews;
    private Probe edge;
    private boolean moving, looked, apertureChecked, yieldRefusal;
    private BlockHitResult ore, lava;
    private Offer offered, direct;
    private Vec3d offeredFeet, passiveFeet;
    private BlockPos passiveAt;
    private Direction passiveBearing;
    private int passiveSince, offeredAt, offeredSeen, offeredTopology, offeredCount, directHop;
    private String activity = "dry route idle";
    private String directReason = "no active dry route";
    private String offerEvidence = "No dry-route observation";
    private Survey surveyOffered, surveyActive;
    private BlockPos surveyedBearingsAt;
    private final EnumSet<Direction> surveyedBearings = EnumSet.noneOf(Direction.class);
    private Probe surveyProbe, surveyed;
    private Vec3d surveyFeet;
    private BlockPos surveySource;
    private Direction surveyBearing;
    private int surveyOfferedAt, surveyStarted, surveyLastTick, surveyedAt;
    private long surveyFrame;
    private boolean surveySampled;

    AgentDryCaveRoute(MinecraftClient client, AgentBody body, BiConsumer<BlockPos, BlockPos> reached) {
        this.client = client;
        this.body = body;
        this.reached = reached;
    }

    String status() { return activity; }
    String directReason() { return directReason; }
    String offerEvidence() { return offerEvidence; }
    long surveyEvidence() { return surveyEvidence; }
    boolean routing() { return edge != null || viewAt != null || centerSince != 0; }
    BlockHitResult ore() { return ore; }
    BlockHitResult lava() { return lava; }

    boolean takeUnprovedView(BlockPos source, Direction direction) {
        if (!source.equals(unprovedAt) || direction != unprovedBearing) return false;
        unprovedAt = null;
        return true;
    }

    Direction takeUnlitDescent(BlockPos source) {
        if (!source.equals(lightAt)) return null;
        lightAt = null;
        return lightBearing;
    }

    Direction takeApertureView(BlockPos source) {
        if (apertureChecked || !source.equals(viewAt)
                || !body.renderedDirection(bearing.getPositiveHorizontalDegrees(), 10, 5)) return null;
        apertureChecked = true;
        return bearing;
    }

    boolean cancelStationarySurvey() {
        if (moving || direct != null) return false;
        interrupt();
        unprovedAt = null;
        yieldRefusal = false;
        return true;
    }

    /** Read only the actual rendered lane; an idle native opportunity never asks Body to steer. */
    Offer offer() {
        ensureLife();
        int now = body.actionTick();
        if (direct != null && lastTurn + 1 < now) clearDirect();
        if (direct != null || surveyActive != null) return noOffer("The dry-route actor already owns a scoped operation.");
        if (player == null || !dry()) {
            offered = null;
            passiveAt = null;
            return noOffer("No live dry first-person stance.");
        }
        BlockPos current = player.getBlockPos();
        if (!offerStance(current)) {
            offered = null;
            passiveAt = null;
            return noOffer("The grounded pose is outside the dry route stance envelope.");
        }
        if (offered != null && (!offerFresh(now) || !sameOfferSource(current))) {
            offered = null;
            passiveAt = null;
        }
        if (!body.dryRouteView()) return noOffer("No recent rendered first-person view.");
        Direction facing = player.getHorizontalFacing();
        if (!directSourceContact(current, facing)) {
            offered = null;
            passiveAt = null;
            return noOffer("The grounded pose is outside the facing lane's support envelope.");
        }
        if (!current.equals(passiveAt) || facing != passiveBearing || player.getPos().squaredDistanceTo(passiveFeet) > 0.01
                || offered == null && now - passiveSince > VIEW_TICKS) {
            offered = null;
            passiveAt = current;
            passiveFeet = player.getPos();
            passiveBearing = facing;
            passiveSince = now;
            for (int i = 0; i < passive.length; i++)
                passive[i] = new Probe(current, current.offset(facing).up(i - 1), facing);
        }
        for (Probe probe : passive) {
            probe.sample(true);
            if (!probe.complete() || !probe.liveFloor) continue;
            if (anchor == null) startGraph(current, facing);
            if (admit(current, probe.to) | admit(probe.to, current)) register(probe.to);
        }
        if (surveyed != null) {
            if (now - surveyedAt > OFFER_MAX_TICKS || !surveyed.from.equals(current)
                    || surveyed.bearing != facing || player.getPos().squaredDistanceTo(surveyFeet) > 0.01) {
                surveyed = null;
            } else {
                surveyed.sample(true);
                if (surveyed.complete() && surveyed.liveFloor
                        && graph.usable(current.asLong(), surveyed.to.asLong())
                        && graph.usable(surveyed.to.asLong(), current.asLong())) {
                    graph.plan(current.asLong()); // Refresh independent homeward proof for this exact pair.
                    if (graph.canReturn(current.asLong()) && graph.canReturn(surveyed.to.asLong())
                            && body.dryRouteVeto(current, surveyed.to) == AgentBody.DryRouteVeto.CLEAR
                            && directPickupClear(surveyed)) {
                        long hop = surveyed.to.asLong();
                        return rememberOffer(current, now, 1, hop);
                    }
                }
            }
        }
        if (anchor == null || graph.plan(current.asLong()) != AgentRouteGraph.Status.MOVE) {
            offered = null;
            return noOffer("No committed paired route. Lower edge: " + passive[0].evidence() + ".");
        }
        int count = graph.directPrefixSize(current.asLong(), offeredHops.length);
        if (count == 0) {
            offered = null;
            return noOffer("The selected route has no supported direct prefix.");
        }
        long first = graph.segmentCell(0);
        Probe firstProbe = surveyed != null && surveyed.to.asLong() == first ? surveyed : null;
        for (Probe probe : passive) if (probe.to.asLong() == first && (firstProbe == null || !firstProbe.liveFloor)) {
            if (firstProbe == null || probe.complete()) firstProbe = probe;
        }
        if (firstProbe == null || !firstProbe.complete() || !firstProbe.liveFloor
                || firstProbe.to.getY() > current.getY() && client.options.jumpKey.isUnbound()) {
            offered = null;
            return noOffer(firstProbe == null ? "The committed first edge is outside this camera lane."
                : "The committed first edge lacks a current paired witness: " + firstProbe.evidence() + ".");
        }
        AgentBody.DryRouteVeto veto = body.dryRouteVeto(firstProbe.from, firstProbe.to);
        if (veto != AgentBody.DryRouteVeto.CLEAR || !directPickupClear(firstProbe)) {
            offered = null;
            return noOffer(veto == AgentBody.DryRouteVeto.CLEAR ? "Visible pickup or incomplete pickup clearance."
                : "The current sweep refused the first edge: " + veto + ".");
        }
        return rememberOffer(current, now, count, AgentRouteGraph.NO_CELL);
    }

    private Offer rememberOffer(BlockPos current, int now, int count, long selectedHop) {
        boolean exact = selectedHop != AgentRouteGraph.NO_CELL;
        boolean same = offerFresh(now) && count == offeredCount;
        for (int i = 0; same && i < count; i++) same = (exact ? selectedHop : graph.segmentCell(i)) == offeredHops[i];
        if (!same) {
            for (int i = 0; i < count; i++) offeredHops[i] = exact ? selectedHop : graph.segmentCell(i);
            offered = new Offer(current, BlockPos.fromLong(offeredHops[0]),
                BlockPos.fromLong(offeredHops[count - 1]), count);
            offeredCount = count;
            offeredFeet = player.getPos();
            offeredAt = now;
            offeredTopology = graph.topologyEpoch();
        }
        offeredSeen = now;
        offerEvidence = "The first directed edge, its return, and the current dry sweep are witnessed.";
        return offered;
    }

    private Offer noOffer(String reason) {
        offerEvidence = reason;
        return null;
    }

    Survey surveyOffer() {
        ensureLife();
        if (player == null || direct != null || surveyActive != null || !dry() || !body.dryRouteView()) return null;
        BlockPos from = player.getBlockPos();
        Direction bearing = player.getHorizontalFacing();
        if (!directSourceContact(from, bearing)) return null;
        BlockPos to = from.offset(bearing).down();
        if (!from.equals(surveyedBearingsAt)) {
            surveyedBearingsAt = from;
            surveyedBearings.clear();
        }
        if (surveyedBearings.contains(bearing)) return null;
        surveySource = from;
        surveyBearing = bearing;
        BlockHitResult lower = body.find(drySurveyBlock, 4, drySurveyFace).orElse(null);
        if (lower == null) return null;
        int now = body.actionTick();
        if (surveyOffered == null || now - surveyOfferedAt >= OFFER_MAX_TICKS || !surveyOffered.from.equals(from)
                || !surveyOffered.to.equals(to)
                || !liveSurveyCue(surveyOffered.witness)) {
            surveyOffered = new Survey(from, to, bearing, lower);
            surveyOfferedAt = now;
        }
        return surveyOffered;
    }

    private boolean visibleLowerFace(BlockHitResult hit) {
        BlockPos pos = hit.getBlockPos();
        // A lit wall/floor face below the lip may justify looking, never stepping.
        int dx = pos.getX() - surveySource.getX(), dz = pos.getZ() - surveySource.getZ();
        int ahead = dx * surveyBearing.getOffsetX() + dz * surveyBearing.getOffsetZ();
        int across = dx * surveyBearing.getOffsetZ() - dz * surveyBearing.getOffsetX();
        return ahead >= 1 && ahead <= 3 && Math.abs(across) <= 1
            && hit.getPos().y >= surveySource.getY() - 1.55 && hit.getPos().y < surveySource.getY() - 0.04
            && (hit.getSide() == Direction.UP || hit.getSide() == surveyBearing.getOpposite());
    }

    private boolean liveSurveyCue(BlockHitResult hit) {
        return body.macroVisible(hit, 4) && drySurveyBlock.test(world.getBlockState(hit.getBlockPos()));
    }

    boolean surveyCurrent(Survey authorization) {
        return authorization != null && authorization == surveyOffered && direct == null && surveyActive == null
            && player != null && dry() && body.actionTick() - surveyOfferedAt < OFFER_MAX_TICKS
            && player.getHorizontalFacing() == authorization.bearing
            && directSourceContact(authorization.from, authorization.bearing)
            && liveSurveyCue(authorization.witness);
    }

    SurveyResult surveyDirect(Survey authorization) {
        int now = body.actionTick();
        if (surveyActive == null) {
            if (!surveyCurrent(authorization)) return SurveyResult.REFUSED;
            surveyActive = authorization;
            surveyedBearings.add(authorization.bearing);
            surveyProbe = new Probe(authorization.from, authorization.to, authorization.bearing);
            surveyFeet = player.getPos();
            surveyStarted = now;
            surveyFrame = body.renderedFrame();
            surveySampled = false;
        } else if (surveyActive != authorization || now != surveyLastTick + 1 || !dry()
                || !directSourceContact(authorization.from, authorization.bearing)
                || player.getPos().squaredDistanceTo(surveyFeet) > 0.01) {
            return SurveyResult.REFUSED;
        }
        surveyLastTick = now;
        int age = now - surveyStarted;
        if (body.dryRouteView() && body.renderedFrame() > surveyFrame) {
            surveyFrame = body.renderedFrame();
            surveyProbe.sample(true);
            surveySampled = true;
            if (surveyProbe.complete() && surveyProbe.liveFloor) {
                if (anchor == null) startGraph(authorization.from, authorization.bearing);
                if (admit(authorization.from, authorization.to) | admit(authorization.to, authorization.from))
                    register(authorization.to);
                if (graph.usable(authorization.from.asLong(), authorization.to.asLong())
                        && graph.usable(authorization.to.asLong(), authorization.from.asLong())) {
                    surveyed = surveyProbe;
                    surveyedAt = now;
                    return SurveyResult.PAIRED;
                }
            }
        }
        if (age >= VIEW_TICKS) return surveySampled ? SurveyResult.UNPROVED : SurveyResult.REFUSED;
        if (body.dryRouteView()) {
            float pitch = switch (age / 11) {
                case 0 -> 68;   // Acquire the lower tread.
                case 1 -> 31;   // Check shin, width and entry.
                case 2 -> -32;  // Check inverse takeoff/headroom.
                default -> 64;  // Finish with a fresh floor, not a memorized view.
            };
            body.turnFixed(authorization.bearing.getPositiveHorizontalDegrees(), pitch);
        }
        return SurveyResult.RUNNING;
    }

    String surveyEvidence(Survey authorization) {
        return authorization == surveyActive && surveyProbe != null ? surveyProbe.evidence() : "view unavailable";
    }

    void cancelSurvey(Survey authorization) {
        if (authorization == surveyActive) {
            surveyActive = null;
            surveyProbe = null;
        }
    }
    private boolean offerFresh(int now) {
        return offered != null && now - offeredSeen <= OFFER_FRESH_TICKS && now - offeredAt < OFFER_MAX_TICKS
            && graph.topologyEpoch() == offeredTopology;
    }

    private boolean offerStance(BlockPos source) {
        return settled(source, 0.27) && player.getPose() == EntityPose.STANDING && !player.isSprinting()
            && !client.options.forwardKey.isUnbound() && player.getVelocity().horizontalLengthSquared() < 0.0121;
    }

    private boolean directSourceContact(BlockPos source, Direction facing) {
        if (!offerStance(source)) return false;
        double x = player.getX() - source.getX() - 0.5, z = player.getZ() - source.getZ() - 0.5;
        double along = x * facing.getOffsetX() + z * facing.getOffsetZ();
        double across = x * facing.getOffsetZ() - z * facing.getOffsetX();
        // Admit ordinary grounded offsets, but leave margin inside Body's exact sweep.
        return Math.abs(along) <= 0.25 && Math.abs(across) <= 0.17;
    }

    private boolean sameOfferSource(BlockPos source) {
        return source.equals(offered.from) && player.getPos().squaredDistanceTo(offeredFeet) <= 0.01;
    }

    DirectResult follow(Offer authorization, int tick) {
        ensureLife();
        if (authorization == null || player == null || !dry())
            return directRefusal("safe dry first-person control is no longer available");
        if (player.isSprinting()) return directRefusal("vanilla sprint is active on a walk-only edge");
        if (client.options.forwardKey.isUnbound()
                || authorization.heightChange() > 0 && client.options.jumpKey.isUnbound())
            return directRefusal("the forward or required jump key is unbound");
        int now = body.actionTick();
        if (direct == null) {
            if (!body.dryRouteView() || authorization != offered || !offerFresh(now) || !offerStance(authorization.from)
                    || !sameOfferSource(authorization.from)
                    || authorization.heightChange() > 0 && client.options.jumpKey.isUnbound()
                    || !directSourceContact(authorization.from, bearing(authorization.from, authorization.next)))
                return directRefusal("witness offer expired or actual source changed");
            interrupt();
            direct = authorization;
            directHop = 0;
            missingDirectViews = 0;
            yieldRefusal = false;
            endpoint = authorization.endpoint;
        } else {
            if (yieldRefusal) return directRefusal(directReason);
            switch (AgentRouteGraph.DirectTurn.classify(authorization == direct, lastTurn, now,
                    body.dryRouteView(), missingDirectViews)) {
                case LOST_OWNER -> {
                    return directRefusal("the exact route lease or native control owner changed");
                }
                case LOST_VIEW -> {
                    return directRefusal("the selected dry sweep lost its rendered view");
                }
                case HOLD -> {
                    int limit = moving ? DRIVE_TICKS : VIEW_TICKS;
                    if (tick - since > limit) return directRefusal("the authorized route deadline expired during a neutral render hold");
                    if (moving && !observeDriveMotion())
                        return directRefusal("actual body path broke continuity during a neutral render hold");
                    ++missingDirectViews;
                    lastTurn = now;
                    activity = directReason = "Dry route holding neutral for its next rendered view.";
                    return DirectResult.RUNNING;
                }
                case DRIVE -> {
                    if (missingDirectViews != 0) directReason = moving ? "traversing the revalidated authorized edge"
                        : "checking the authorized next edge";
                    missingDirectViews = 0;
                }
            }
            if (graph.topologyEpoch() != offeredTopology) {
                long from = directHop == 0 ? direct.from.asLong() : offeredHops[directHop - 1];
                if (!graph.revalidateDirectSuffix(from, offeredHops, directHop, offeredCount))
                    return directRefusal("the pinned directed route or its proved return changed");
                offeredTopology = graph.topologyEpoch();
            }
        }
        lastTurn = now;
        if (edge == null) {
            BlockPos from = directHop == 0 ? direct.from : BlockPos.fromLong(offeredHops[directHop - 1]);
            BlockPos to = BlockPos.fromLong(offeredHops[directHop]);
            if (directHop == 0 ? !sameOfferSource(from) || !directSourceContact(from, bearing(from, to))
                    : !settled(from, 0.22)) return directRefusal("did not remain on the authorized support");
            if (!graph.revalidateDirectSuffix(from.asLong(), offeredHops, directHop, offeredCount))
                return directRefusal("the exact next edge or its proved return path changed");
            edge = new Probe(from, to, bearing(from, to));
            since = tick;
            activity = "dry route selected: authorized return-connected segment to " + at(endpoint)
                + "; next " + at(from) + " -> " + at(to);
            directReason = "checking the authorized next edge";
            return DirectResult.RUNNING;
        }
        if (moving) drive(tick);
        else {
            if (directHop == 0 && !sameOfferSource(edge.from))
                return directRefusal("actual source changed while revalidating the selected edge");
            validate(tick, player.getBlockPos());
        }
        if (yieldRefusal || edge == null && (!player.isOnGround()
                || !player.getBlockPos().equals(BlockPos.fromLong(offeredHops[directHop])))) {
            clearDirect();
            return DirectResult.REFUSED;
        }
        if (edge == null && ++directHop == offeredCount) {
            directReason = "settled on the authorized segment endpoint";
            clearDirect();
            return DirectResult.ARRIVED;
        }
        return DirectResult.RUNNING;
    }

    private DirectResult directRefusal(String reason) {
        directReason = reason;
        activity = "dry route refused: " + reason;
        clearDirect();
        return DirectResult.REFUSED;
    }

    private void clearDirect() {
        direct = offered = null;
        yieldRefusal = false;
        interrupt();
    }

    void cancel(Offer authorization) {
        if (authorization != null && (authorization == direct || authorization == offered)) clearDirect();
    }

    boolean inFlight(Offer authorization) {
        return authorization != null && authorization == direct && world == client.world && player == client.player
            && moving && edge != null && authorization.edges() == 1 && authorization.heightChange() != 0
            && edge.from.equals(authorization.from()) && edge.to.equals(authorization.endpoint());
    }

    boolean relevant(BlockPos foot) {
        ensureLife();
        return anchor != null && (edge != null || graph.contains(foot.asLong()));
    }

    void openAt(BlockPos foot) {
        ensureLife();
        if (anchor != null && player != null && settled(foot, 0.22)) register(foot);
    }

    /** The old linear trail is not proof: connect only the actual successive dry player contacts. */
    void contact(long tick) {
        ensureLife();
        if (offered != null && direct == null && (player == null || !dry()
                || !offerStance(offered.from) || !sameOfferSource(offered.from))) {
            // Moving away and back between refresh calls must not revive an old offer.
            offered = null;
            passiveAt = null;
        }
        if (anchor == null || player == null) return;
        Vec3d feet = player.getPos();
        if (!dry() || tick != lastPoseTick + 1 || lastFeet == null
                || feet.squaredDistanceTo(lastFeet) > 0.42) contact = null;
        lastPoseTick = tick;
        lastFeet = feet;
        if (!dry()) return;
        BlockPos current = player.getBlockPos();
        boolean settled = settled(current, 0.21);
        if (contact != null && (!current.equals(contact) || !settled)) {
            double x = feet.x - contact.getX() - 0.5, z = feet.z - contact.getZ() - 0.5;
            if (contactBearing == null && Math.max(Math.abs(x), Math.abs(z)) > 0.29) {
                contactBearing = Math.abs(x) >= Math.abs(z) ? (x > 0 ? Direction.EAST : Direction.WEST)
                    : (z > 0 ? Direction.SOUTH : Direction.NORTH);
            }
            if (tick - lastContactTick > 16 || feet.y < contact.getY() - 1.055
                    || feet.y > contact.getY() + 1.32) contact = null;
            else if (contactBearing != null) {
                double along = x * contactBearing.getOffsetX() + z * contactBearing.getOffsetZ();
                double across = x * contactBearing.getOffsetZ() - z * contactBearing.getOffsetX();
                if (along < -0.03 || along > 1.24 || Math.abs(across) > 0.24) contact = null;
            }
        }
        if (!settled) return;
        if (contact != null && contactBearing != null && cardinal(contact, current)
                && bearing(contact, current) == contactBearing) walked(contact, current);
        contact = current;
        contactBearing = null;
        lastContactTick = tick;
    }

    void walked(BlockPos from, BlockPos to) {
        ensureLife();
        if (!cardinal(from, to)) return;
        if (anchor == null && player != null && dry() && settled(to, 0.22)) startGraph(from, bearing(from, to));
        if (anchor != null) graph.walked(from.asLong(), to.asLong());
    }

    /** Other ordinary jobs may supply independently witnessed dry geometry, not planned coordinates. */
    void witnessed(BlockPos from, BlockPos to) {
        ensureLife();
        if (anchor == null || !cardinal(from, to)) return;
        admit(from, to);
    }

    void changed(BlockPos changed) {
        if (world != client.world || player != client.player) return;
        if (passiveAt != null) for (Probe probe : passive) if (probe.touches(changed)) probe.reset();
        if (surveyed != null && surveyed.touches(changed)) surveyed = null;
        if (surveyProbe != null && surveyProbe.touches(changed)) surveyProbe.reset();
        if (surveyOffered != null && (touches(surveyOffered.from, surveyOffered.to, changed)
                || surveyOffered.witness.getBlockPos().equals(changed))) surveyOffered = null;
        if (surveyedBearingsAt != null) surveyedBearings.removeIf(direction ->
            touches(surveyedBearingsAt, surveyedBearingsAt.offset(direction).down(), changed));
        if (anchor == null) return;
        for (int i = 0; i < 4; i++) {
            Direction forward = direction(i);
            for (int y = -3; y <= 2; y++) {
                BlockPos here = changed.up(y);
                changeAt(here, i, forward, changed);
                changeAt(here.offset(forward.getOpposite()), i, forward, changed);
            }
        }
        if (edge != null && edge.touches(changed)) {
            if (moving) refuse(Retirement.OBSTRUCTION, "geometry changed during the selected sweep");
            else edge.reset();
        }
        if (viewAt != null || completedViewTick >= 0)
            for (Probe candidate : candidates) if (candidate.touches(changed)) candidate.reset();
    }

    private void changeAt(BlockPos from, int index, Direction forward, BlockPos change) {
        boolean affected = false;
        for (int rise = -1; rise <= 1; rise++) {
            BlockPos to = from.offset(forward).up(rise);
            if (!touches(from, to, change)) continue;
            if (graph.usable(from.asLong(), to.asLong())) {
                graph.retire(from.asLong(), to.asLong(), Retirement.OBSTRUCTION);
            } else if (graph.retirement(from.asLong(), to.asLong()) == Retirement.EXECUTION) {
                // A real work receipt inside the old failed sweep makes new admission meaningful.
                graph.reopen(from.asLong(), to.asLong(), Retirement.EXECUTION);
                graph.retire(from.asLong(), to.asLong(), Retirement.OBSTRUCTION);
            }
            affected = true;
        }
        if (affected) graph.reopenFrontier(from.asLong(), index);
    }

    void lightChanged(BlockPos foot, Direction sector) {
        if (foot.equals(surveyedBearingsAt)) surveyedBearings.remove(sector);
        if (anchor == null) return;
        for (int i = 0; i < 4; i++) {
            if (direction(i) != sector) continue;
            if (!graph.reopenFrontier(foot.asLong(), i)) graph.frontier(foot.asLong(), i);
            break;
        }
        if (foot.equals(viewAt)) clearView();
        if (foot.equals(unprovedAt) && sector == unprovedBearing) unprovedAt = null;
    }

    boolean step(int tick, BlockPos current, Direction prefer, Predicate<BlockState> preferredOre) {
        ensureLife();
        ore = lava = null;
        if (player == null || world == null || prefer == null) return false;
        if (direct != null) clearDirect();
        if (lastTurn + 1 != body.actionTick()) interrupt();
        lastTurn = body.actionTick();
        if (yieldRefusal) { yieldRefusal = false; return true; }
        if (!dry()) {
            if (edge != null) refuse(Retirement.HAZARD, "lost dry footing or safe ownership");
            else interrupt();
            return false;
        }
        if (edge != null && moving) return drive(tick);
        if (!player.isOnGround() || Math.abs(player.getY() - current.getY()) > 0.055) return false;
        if (!settled(current, 0.16)) {
            if (centerSince == 0) centerSince = tick;
            if (tick - centerSince > 20) {
                interrupt();
                activity = "dry route refused: could not center on the actual source support";
                return false;
            }
            body.centerOnSupport(current.down());
            activity = "dry route centering on actual source support";
            return true;
        }
        centerSince = 0;
        if (anchor == null) {
            startGraph(current, prefer);
            register(anchor);
        }
        if (viewAt != null) return survey(tick, current, preferredOre);
        if (edge != null) return validate(tick, current);
        long cell = current.asLong();
        AgentRouteGraph.Status result = graph.plan(cell);
        if (result != AgentRouteGraph.Status.LIMIT) limitedAt = null;
        return switch (result) {
            case MOVE -> {
                BlockPos next = BlockPos.fromLong(graph.next());
                endpoint = BlockPos.fromLong(graph.endpoint());
                edge = selectedProbe(current, next, tick);
                since = tick;
                activity = "dry route selected: " + (endpoint.getY() < current.getY() ? "lower" : "unexamined")
                    + " return-connected frontier " + at(endpoint)
                    + "; next " + at(current) + " -> " + at(next);
                yield true;
            }
            case FRONTIER -> {
                startView(tick, current, graph.frontierBearing());
                yield true;
            }
            case NO_ROUTE -> noRoute("no unexamined return-connected frontier");
            case STRANDED -> noRoute("no proved connection from the actual source to the route anchor");
            case LIMIT -> {
                // A completed return search can use this turn's allowance; a second
                // bounded decision can reuse it rather than forgetting the return spine.
                if (!current.equals(limitedAt)) {
                    limitedAt = current;
                    activity = "dry route search reached its bound; keeping the attested return spine";
                    yield true;
                }
                yield noRoute("bounded search or graph capacity exhausted; route availability is unknown");
            }
            case GOAL -> noRoute("selected work site reached");
        };
    }

    private boolean noRoute(String reason) {
        activity = "dry route refused: " + reason;
        return false;
    }

    private void startView(int tick, BlockPos current, int index) {
        viewAt = current;
        unprovedAt = lightAt = null;
        completedViewTick = -1000;
        viewIndex = index;
        viewAdmissions = 0;
        since = tick;
        bearing = direction(index);
        looked = apertureChecked = false;
        for (int i = 0; i < candidates.length; i++) candidates[i] = new Probe(current, current.offset(bearing).up(i - 1), bearing);
        activity = "dry route next lawful view: " + at(current) + " looking " + bearing;
    }

    private boolean survey(int tick, BlockPos current, Predicate<BlockState> preferredOre) {
        if (!current.equals(viewAt)) {
            interrupt();
            return noRoute("actual view source moved");
        }
        int age = tick - since;
        look(bearing, age);
        if (!looked && body.renderedDirection(bearing.getPositiveHorizontalDegrees(), 10, 20)) {
            looked = true;
            if (preferredOre == null) lava = body.visibleFluid(true, true, 14);
            else ore = body.find(preferredOre, 12, hit -> !hit.getBlockPos().equals(current.down())
                && player.getEyePos().squaredDistanceTo(hit.getPos()) <= 3.9 * 3.9).orElse(null);
            if (ore != null || lava != null) {
                graph.consumeFrontier(current.asLong(), viewIndex);
                clearView();
                activity = "dry route view exposed reachable objective work";
                return false;
            }
        }
        boolean pending = false, proved = false;
        for (Probe candidate : candidates) {
            candidate.sample();
            if (candidate.complete()) {
                proved = true;
                if (admit(candidate.from, candidate.to) | admit(candidate.to, candidate.from)) {
                    register(candidate.to);
                    surveyEvidence++;
                    viewAdmissions++;
                }
            } else if (candidate.failure != Retirement.OBSTRUCTION && candidate.failure != Retirement.HAZARD) {
                pending = true;
            }
        }
        if (viewAdmissions == 0 && age < VIEW_TICKS && (pending || !looked)) return true;
        for (Probe candidate : candidates) {
            if (!candidate.complete() && candidate.failure != null)
                graph.retire(candidate.from.asLong(), candidate.to.asLong(), candidate.failure);
        }
        graph.consumeFrontier(current.asLong(), viewIndex);
        if (!proved) {
            unprovedAt = current;
            unprovedBearing = bearing;
            Probe drop = candidates[0];
            if (drop.failure != Retirement.HAZARD && drop.failure != Retirement.OBSTRUCTION
                    && (drop.floorEvidence == AgentBody.DryRouteTop.DARK
                        || drop.floorEvidence == AgentBody.DryRouteTop.NO_FULL_TOP && (drop.mask & 4) != 0)) {
                lightAt = current;
                lightBearing = bearing;
            }
        }
        activity = "dry route view result: " + at(current) + " " + bearing + "; admitted=" + viewAdmissions
            + "; down=" + candidates[0].evidence() + "; level=" + candidates[1].evidence()
            + "; up=" + candidates[2].evidence();
        completedViewTick = tick;
        clearView();
        return true;
    }

    private Probe selectedProbe(BlockPos from, BlockPos to, int tick) {
        if (tick - completedViewTick <= 2) {
            for (Probe candidate : candidates) {
                if (candidate.from.equals(from) && candidate.to.equals(to) && candidate.complete()) return candidate;
            }
        }
        return new Probe(from, to, bearing(from, to));
    }

    private boolean validate(int tick, BlockPos current) {
        if (!current.equals(edge.from)) {
            if (direct != null) {
                directReason = "actual source changed before the selected edge";
                yieldRefusal = true;
            }
            interrupt();
            return noRoute("actual source changed before the selected edge");
        }
        int age = tick - since;
        edge.sample(direct != null && directHop == 0 && directSourceContact(edge.from, edge.bearing));
        if (edge.failure == Retirement.OBSTRUCTION || edge.failure == Retirement.HAZARD) {
            refuse(edge.failure, "current camera blocks the selected edge: " + edge.evidence());
        } else if (edge.complete() && edge.liveFloor) {
            if (!sweepRefused() && allowsDirectMovement()) {
                moving = true;
                since = tick;
                lastDriveFeet = player.getPos();
                movingContacts = 0;
                missingDriveViews = 0;
                if (direct != null) directReason = "traversing the revalidated authorized edge";
                activity = "dry route revalidated " + at(edge.from) + " -> " + at(edge.to)
                    + "; held frontier " + at(endpoint);
                body.driveDryRoute(edge.from, edge.to, edge.bearing);
            }
        } else if (age >= VIEW_TICKS) {
            refuse(edge.failure == Retirement.LIGHT ? Retirement.LIGHT : Retirement.OBSERVATION,
                "fresh lit forward/return evidence unavailable: " + edge.evidence());
        } else look(edge.bearing, age);
        return true;
    }

    private boolean drive(int tick) {
        if (!observeDriveMotion()) {
            refuse(Retirement.EXECUTION, "actual body path stopped being contiguous");
            return true;
        }
        if (!body.dryRouteView()) {
            // Inputs are cleared each tick. A missed render can interrupt the stride
            // without proving that a previously seen shelf has disappeared.
            if (++missingDriveViews > 2 || tick - since > DRIVE_TICKS)
                refuse(Retirement.OBSERVATION, "could not reacquire the selected sweep in a fresh rendered view");
            else activity = "dry route holding inputs until the selected sweep is visible again";
            return true;
        }
        missingDriveViews = 0;
        if (sweepRefused()) return true;
        if (movingContacts >= 3 && settled(edge.to, 0.22) && player.getVelocity().horizontalLengthSquared() <= 0.016) {
            BlockPos arrived = edge.to;
            walked(edge.from, arrived);
            reached.accept(edge.from, arrived);
            activity = "dry route settled arrival " + at(arrived) + "; committed frontier " + at(endpoint);
            edge = null;
            moving = false;
            return true;
        }
        if (tick - since > DRIVE_TICKS) {
            refuse(Retirement.EXECUTION, "traversal did not settle on the selected support");
        } else {
            // Positive forward/return proofs preceded this short sweep. Visible geometry can still veto.
            edge.sample();
            if (edge.failure == Retirement.OBSTRUCTION || edge.failure == Retirement.HAZARD)
                refuse(edge.failure, "new visible obstruction during traversal");
            else if (allowsDirectMovement()) body.driveDryRoute(edge.from, edge.to, edge.bearing);
        }
        return true;
    }

    private boolean observeDriveMotion() {
        Vec3d feet = player.getPos();
        if (feet.squaredDistanceTo(lastDriveFeet) > 0.31) return false;
        double dx = feet.x - lastDriveFeet.x, dz = feet.z - lastDriveFeet.z;
        if (dx * dx + dz * dz > 0.0004) movingContacts++;
        lastDriveFeet = feet;
        return true;
    }

    private boolean sweepRefused() {
        switch (body.dryRouteVeto(edge.from, edge.to)) {
            case CLEAR -> { return false; }
            case VIEW -> refuse(Retirement.OBSERVATION, "current rendered view unavailable");
            case HAZARD -> refuse(Retirement.HAZARD, "hazard intersects the chosen sweep");
            case DRIFT -> refuse(Retirement.EXECUTION, "actual body left the chosen sweep's motion envelope");
            case SWEEP -> refuse(Retirement.OBSTRUCTION, "chosen body-width or headroom sweep blocked");
            case SUPPORT -> refuse(Retirement.OBSTRUCTION, "chosen landing lost supporting contact");
        }
        return true;
    }

    private void refuse(Retirement reason, String why) {
        graph.retire(edge.from.asLong(), edge.to.asLong(), reason);
        if (direct != null) directReason = why;
        activity = "dry route refused [" + reason + "] " + at(edge.from) + " -> " + at(edge.to) + ": " + why;
        edge = null;
        moving = false;
        yieldRefusal = true;
        graph.cancelPlan();
    }

    private boolean allowsDirectMovement() {
        if (direct == null || directPickupClear(edge)) return true;
        directReason = "visible pickup or lost pickup clearance on the authorized sweep";
        activity = "dry route refused: " + directReason;
        edge = null;
        moving = false;
        yieldRefusal = true;
        return false;
    }

    private boolean directPickupClear(Probe probe) {
        int fromY = probe.from.getY(), toY = probe.to.getY();
        return body.macroNoVisiblePickup(Vec3d.ofBottomCenter(probe.to),
            Math.min(fromY, toY), Math.max(fromY, toY) + (toY > fromY ? 0.32 : 0));
    }

    private boolean admit(BlockPos from, BlockPos to) {
        long a = from.asLong(), b = to.asLong();
        Retirement reason = graph.retirement(a, b);
        return reason == null ? graph.observe(a, b)
            : reason != Retirement.EXECUTION && reason != Retirement.RESOURCES && graph.reopen(a, b, reason);
    }

    private void register(BlockPos foot) {
        for (int i = 0; i < 4; i++) graph.frontier(foot.asLong(), i);
    }

    private void ensureLife() {
        if (world == client.world && player == client.player) return;
        world = client.world;
        player = client.player;
        anchor = contact = null;
        lastFeet = null;
        limitedAt = null;
        passiveAt = null;
        unprovedAt = lightAt = null;
        direct = offered = null;
        surveyOffered = surveyActive = null;
        surveyedBearingsAt = null;
        surveyedBearings.clear();
        surveyProbe = surveyed = null;
        yieldRefusal = false;
        interrupt();
    }

    private void startGraph(BlockPos current, Direction prefer) {
        anchor = current;
        basis = prefer;
        graph.reset(anchor.asLong());
    }

    private void interrupt() {
        if (anchor != null) graph.cancelPlan();
        clearView();
        completedViewTick = -1000;
        edge = null;
        endpoint = null;
        moving = false;
        centerSince = 0;
    }

    private void clearView() { viewAt = null; }

    private boolean dry() {
        return player.isAlive() && !player.isTouchingWater() && !player.isInLava() && !player.isOnFire()
            && !player.hasVehicle() && player.hurtTime == 0 && !body.lavaEmergency()
            && client.currentScreen == null && client.getOverlay() == null;
    }

    private boolean settled(BlockPos foot, double margin) {
        return player.isOnGround() && player.getBlockPos().equals(foot) && Math.abs(player.getY() - foot.getY()) <= 0.055
            && Math.abs(player.getX() - foot.getX() - 0.5) <= margin
            && Math.abs(player.getZ() - foot.getZ() - 0.5) <= margin;
    }

    private Direction direction(int index) {
        return switch (index) {
            case 0 -> basis;
            case 1 -> basis.rotateYClockwise();
            case 2 -> basis.rotateYCounterclockwise();
            default -> basis.getOpposite();
        };
    }

    private static Direction bearing(BlockPos from, BlockPos to) {
        if (from.getX() < to.getX()) return Direction.EAST;
        if (from.getX() > to.getX()) return Direction.WEST;
        return from.getZ() < to.getZ() ? Direction.SOUTH : Direction.NORTH;
    }

    private static boolean cardinal(BlockPos from, BlockPos to) {
        return Math.abs(from.getX() - to.getX()) + Math.abs(from.getZ() - to.getZ()) == 1
            && Math.abs(from.getY() - to.getY()) <= 1;
    }

    private void look(Direction direction, int age) {
        body.turnFixed(direction.getPositiveHorizontalDegrees(), probePitch(age));
    }

    private static float probePitch(int age) {
        return age < 14 ? 10 : age < 24 ? -58 : age < 32 ? 31 : age < 43 ? 68 : 46;
    }

    private static String at(BlockPos foot) { return foot.toShortString(); }

    private static boolean touches(BlockPos from, BlockPos to, BlockPos changed) {
        int y = changed.getY();
        return (from.getX() == changed.getX() && from.getZ() == changed.getZ()
            || to.getX() == changed.getX() && to.getZ() == changed.getZ())
            && y >= Math.min(from.getY(), to.getY()) - 1 && y <= Math.max(from.getY(), to.getY()) + 2;
    }

    private final class Probe {
        private final BlockPos from, to;
        private final Direction bearing;
        private final Vec3d floor, alternateFloor;
        private final BlockPos support;
        private final Vec3d[] clearance;
        private int mask, blocked, wet, dark;
        private boolean liveFloor;
        private Retirement failure;
        private AgentBody.DryRouteTop floorEvidence = AgentBody.DryRouteTop.OUT_OF_VIEW;

        private Probe(BlockPos from, BlockPos to, Direction bearing) {
            this.from = from;
            this.to = to;
            this.bearing = bearing;
            support = to.down();
            Vec3d source = Vec3d.ofBottomCenter(from), landing = Vec3d.ofBottomCenter(to);
            double x = bearing.getOffsetX(), z = bearing.getOffsetZ();
            double rise = landing.y - source.y, upper = Math.max(landing.y, source.y);
            floor = landing.add(x * 0.36, -0.025, z * 0.36);
            alternateFloor = landing.add(x * 0.15, -0.025, z * 0.15);
            Vec3d entry = new Vec3d(landing.x - x * 0.38, upper, landing.z - z * 0.38);
            Vec3d lower = rise < 0 ? landing : source;
            double lowerAhead = rise < 0 ? -0.27 : 0.37;
            clearance = new Vec3d[] {landing.add(0, 0.16, 0), landing.add(0, 1.76, 0),
                landing.add(z * 0.34, 0.94, -x * 0.34), landing.add(-z * 0.34, 0.94, x * 0.34),
                entry.add(z * 0.34, 0.86, -x * 0.34), entry.add(-z * 0.34, 1.70, x * 0.34),
                rise == 0 ? null : lower.add(x * lowerAhead, 2.76, z * lowerAhead)};
        }

        private void reset() {
            mask = blocked = wet = dark = 0;
            floorEvidence = AgentBody.DryRouteTop.OUT_OF_VIEW;
            failure = null;
        }

        private boolean complete() { return mask == COMPLETE; }
        private boolean touches(BlockPos changed) { return AgentDryCaveRoute.touches(from, to, changed); }

        private void sample() { sample(false); }

        private void sample(boolean directSource) {
            AgentBody.DryRouteTop top = body.dryRouteTop(floor, support);
            if (top != AgentBody.DryRouteTop.WITNESSED) {
                AgentBody.DryRouteTop other = body.dryRouteTop(alternateFloor, support);
                if (other == AgentBody.DryRouteTop.WITNESSED || top == AgentBody.DryRouteTop.OUT_OF_VIEW
                        || other == AgentBody.DryRouteTop.FLUID) top = other;
            }
            liveFloor = top == AgentBody.DryRouteTop.WITNESSED;
            if (top != AgentBody.DryRouteTop.OUT_OF_VIEW) floorEvidence = top;
            if (liveFloor) mask |= 1;
            else if (top == AgentBody.DryRouteTop.NO_FULL_TOP || top == AgentBody.DryRouteTop.FLUID) mask &= ~1;
            // Actual stable source contact is independent evidence for the reverse landing.
            // It does not certify any unseen tile or the inverse takeoff/headroom.
            if (directSource || settled(from, 0.18) && player.getPose() == EntityPose.STANDING
                    && player.getVelocity().horizontalLengthSquared() < 0.0121) mask |= 0x80;
            for (int i = 0; i < clearance.length; i++) {
                Vec3d point = clearance[i];
                int bit = i < 6 ? 2 << i : 0x100;
                if (point == null) {
                    mask |= bit;
                    continue;
                }
                switch (body.dryRouteClear(point)) {
                    case CLEAR -> {
                        mask |= bit;
                        blocked &= ~bit;
                        wet &= ~bit;
                        dark &= ~bit;
                    }
                    case FLUID -> { mask &= ~bit; wet |= bit; }
                    case OBSTRUCTION -> {
                        mask &= ~bit;
                        blocked |= bit;
                    }
                    case DARK -> { mask &= ~bit; dark |= bit; }
                    case UNKNOWN -> { }
                }
            }
            failure = wet != 0 || floorEvidence == AgentBody.DryRouteTop.FLUID ? Retirement.HAZARD
                : blocked != 0 ? Retirement.OBSTRUCTION
                : dark != 0 || (mask & 1) == 0 && floorEvidence == AgentBody.DryRouteTop.DARK ? Retirement.LIGHT : null;
        }

        private String evidence() {
            if (complete()) return liveFloor ? "forward and return witnessed"
                : "forward and return witnessed; top not currently in view";
            StringBuilder gaps = new StringBuilder();
            if ((mask & 1) == 0) gaps.append("top:").append(floorEvidence).append(' ');
            if ((mask & 2) == 0) appendGap(gaps, "shin", 2);
            if ((mask & 4) == 0) appendGap(gaps, "head", 4);
            if ((mask & 24) != 24) appendGap(gaps, "width", 24);
            if ((mask & 96) != 96) appendGap(gaps, "entry", 96);
            if ((mask & 0x80) == 0) gaps.append("reverse-standing-contact:unproved ");
            if ((mask & 0x100) == 0) appendGap(gaps, "takeoff-headroom", 0x100);
            return gaps.toString().stripTrailing();
        }

        private void appendGap(StringBuilder gaps, String area, int bits) {
            gaps.append(area).append(':').append((wet & bits) != 0 ? "fluid" : (blocked & bits) != 0 ? "blocked"
                : (dark & bits) != 0 ? "dark" : "unwitnessed").append(' ');
        }
    }
}
