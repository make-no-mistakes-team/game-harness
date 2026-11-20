package io.gameharness.survival;

import io.gameharness.survival.AgentRouteGraph.Retirement;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
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
    private static final int VIEW_TICKS = 18, DRIVE_TICKS = 23;
    private static final int OFFER_FRESH_TICKS = 24, OFFER_MAX_TICKS = 1200;
    private static final int STRIP_EDGES = 4, WITNESS_TICKS = 30, PROBE_CACHE_SIZE = 48;
    private static final int SURVEY_LANES = 512;
    record Offer(BlockPos from, BlockPos next, BlockPos endpoint, int edges) {
        int heightChange() { return endpoint.getY() - from.getY(); }
    }
    static final class Survey {
        private final BlockPos from, to;
        private final Direction bearing;
        private final BlockHitResult witness;
        private final float pitch;

        private Survey(BlockPos from, BlockPos to, Direction bearing, BlockHitResult witness, float pitch) {
            this.from = from;
            this.to = to;
            this.bearing = bearing;
            this.witness = witness;
            this.pitch = pitch;
        }

        Direction bearing() { return bearing; }
        BlockPos target() { return to; }
    }
    private record SurveyLane(BlockPos from, Direction bearing) {}
    enum SurveyResult { RUNNING, PAIRED, UNPROVED, REFUSED }
    enum DirectResult { RUNNING, ARRIVED, REFUSED }
    enum LevelPassage { WITNESSED, UNPROVED, HAZARD }

    private final MinecraftClient client;
    private final AgentBody body;
    private final BiConsumer<BlockPos, BlockPos> reached;
    private final AgentRouteGraph graph = new AgentRouteGraph();
    private final AgentWalkedRoute.Motion driveMotion = new AgentWalkedRoute.Motion();
    private final BlockPos.Mutable driveSupport = new BlockPos.Mutable();
    private final Probe[] candidates = new Probe[3];
    private final Probe[] probes = new Probe[PROBE_CACHE_SIZE];
    private final Map<SurveyLane, Survey> examinedLips = new HashMap<>();
    private final ProbeView probeView;
    private final Predicate<BlockState> drySurveyBlock = state -> !state.isAir() && state.getFluidState().isEmpty();
    private final Predicate<BlockHitResult> drySurveyFace = this::visibleLowerFace;
    private final long[] offeredHops = new long[STRIP_EDGES];
    private ClientWorld world;
    private ClientPlayerEntity player;
    private Direction basis, bearing, unprovedBearing, lightBearing;
    private BlockPos anchor, contact, viewAt, endpoint, limitedAt, unprovedAt, lightAt;
    private Direction contactBearing;
    private Vec3d lastFeet;
    private long lastContactTick, lastPoseTick, surveyEvidence;
    private int viewIndex, since, lastTurn, centerSince, probeCursor;
    private int missingDriveViews;
    private int missingDirectViews;
    private Probe edge;
    private BlockState driveSource, driveLanding;
    private long plannedAhead = AgentRouteGraph.NO_CELL;
    private boolean moving, apertureChecked, yieldRefusal;
    private BlockHitResult ore, lava;
    private Offer offered, direct;
    private Consumer<AgentSurfaceTread.Edge> directLanded;
    private boolean stopDirectAfterArrival;
    private Vec3d offeredFeet;
    private int offeredAt, offeredSeen, offeredTopology, offeredCount, directHop;
    private int offerReadAt = -1, surveyReadAt = -1;
    private long offerReadFrame = -1, surveyReadFrame = -1;
    private String activity = "dry route idle";
    private String directReason = "no active dry route";
    private String offerEvidence = "No dry-route observation";
    private Survey surveyOffered, surveyActive;
    private Probe surveyProbe, surveyed;
    private Vec3d surveyFeet, surveyOfferedFeet;
    private BlockPos surveySource;
    private Direction surveyBearing;
    private int surveyOfferedAt, surveyStarted, surveyLastTick, surveyViewedAt, surveyedAt;
    private long surveyFrame;
    private boolean surveyGeometryChanged;

    AgentDryCaveRoute(MinecraftClient client, AgentBody body, BiConsumer<BlockPos, BlockPos> reached) {
        this.client = client;
        this.body = body;
        this.reached = reached;
        probeView = body.dryCaveProbeView();
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
                || !body.dryRouteView() || player.getHorizontalFacing() != bearing) return null;
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
            return noOffer("No live dry first-person stance.");
        }
        BlockPos current = player.getBlockPos();
        if (!body.dryRouteView()) return noOffer("No recent rendered first-person view.");
        Direction facing = player.getHorizontalFacing();
        if (!directSourceContact(current, facing)) {
            offered = null;
            return noOffer("The grounded pose is outside the facing lane's support envelope.");
        }
        if (offered != null && (!offerFresh(now) || !sameOfferSource(current))) offered = null;
        if (surveyed != null && (now - surveyedAt > WITNESS_TICKS
                || !surveyed.from.equals(current) || surveyed.bearing != facing)) surveyed = null;
        long frame = body.renderedFrame();
        if (now == offerReadAt && frame == offerReadFrame) return offered;
        offerReadAt = now;
        offerReadFrame = frame;
        int level = sampleStrip(current, facing);
        Probe down = selectedProbe(current, current.offset(facing).down());
        Probe up = selectedProbe(current, current.offset(facing).up());
        // A straight multi-edge lane is already the longest observed run in this
        // bearing. On a split at one edge keep the route graph's existing work priority.
        if (level < 2 || surveyed == down) {
            observePair(down, null, 0);
            if (level == 0 && !paired(down)) observePair(up, null, 0);
        }
        if (anchor != null) {
            AgentRouteGraph.Status plan = graph.plan(current.asLong());
            if (graph.canReturn(current.asLong())) {
                if (surveyed == down && canOffer(down)) return rememberOffer(current, down.to, now, 1);
                if (level < 2 && plan == AgentRouteGraph.Status.MOVE) {
                    long first = graph.next();
                    if (first == down.to.asLong() && canOffer(down)) return rememberOffer(current, down.to, now, 1);
                    if (first == up.to.asLong() && canOffer(up)) return rememberOffer(current, up.to, now, 1);
                }
                Probe first = selectedProbe(current, current.offset(facing));
                if (level > 0 && canOffer(first)) {
                    int count = 1;
                    for (; count < level; count++) {
                        BlockPos from = current.offset(facing, count);
                        Probe next = selectedProbe(from, from.offset(facing));
                        if (!paired(next) || !graph.canReturn(next.to.asLong()) || !directPickupClear(next)) break;
                    }
                    return rememberOffer(current, current.offset(facing, count), now, count);
                }
                if (canOffer(down)) return rememberOffer(current, down.to, now, 1);
                if (canOffer(up)) return rememberOffer(current, up.to, now, 1);
            }
        }
        offered = null;
        return noOffer("No witnessed forward strip with a proved return. Level: "
            + selectedProbe(current, current.offset(facing)).evidence() + "; lower: " + down.evidence() + ".");
    }

    private boolean canOffer(Probe probe) {
        return paired(probe) && graph.canReturn(probe.to.asLong())
            && (probe.to.getY() <= probe.from.getY() || !client.options.jumpKey.isUnbound())
            && negativeTransitVetoesClear(probe)
            && body.dryRouteVeto(probe.from, probe.to) == AgentBody.DryRouteVeto.CLEAR && directPickupClear(probe);
    }

    private boolean negativeTransitVetoesClear(Probe probe) {
        // Only called after positive paired evidence. Neither veto adds terrain to the graph.
        int now = body.actionTick();
        if (probe.lastTransitCheck != now) {
            probe.lastTransitCheck = now;
            probe.transitClear = body.walkedLaneDry(probe.from, probe.to, probe.bearing)
                && AgentSurfaceTread.retainedLaneClear(client, probe.from, probe.to, probe.bearing);
        }
        return probe.transitClear;
    }

    /** Visible lower passage only. The caller must still veto the exact dry standing sweep. */
    LevelPassage levelPassage(BlockPos from, BlockPos to) {
        ensureLife();
        if (player == null || !dry() || !body.dryRouteView() || !settled(from, 0.27)
                || from.getY() != to.getY() || !cardinal(from, to)) return LevelPassage.UNPROVED;
        Probe probe = selectedProbe(from, to);
        sampleEdge(probe);
        if (probe.failure == Retirement.HAZARD) return LevelPassage.HAZARD;
        return probe.complete(body.actionTick()) ? LevelPassage.WITNESSED : LevelPassage.UNPROVED;
    }

    private Offer rememberOffer(BlockPos current, BlockPos end, int now, int count) {
        if (!offerFresh(now) || !end.equals(offered.endpoint) || count != offeredCount) {
            Direction forward = bearing(current, end);
            for (int i = 0; i < count; i++) offeredHops[i] = count == 1 ? end.asLong() : current.offset(forward, i + 1).asLong();
            offered = new Offer(current, count == 1 ? end : current.offset(forward), end, count);
            offeredCount = count;
            offeredFeet = player.getPos();
            offeredAt = now;
            offeredTopology = graph.topologyEpoch();
        }
        offeredSeen = now;
        offerEvidence = "Witnessed " + count + " paired dry " + (count == 1 ? "edge." : "edges in one forward strip.");
        return offered;
    }

    private Offer noOffer(String reason) {
        offerEvidence = reason;
        return null;
    }

    Survey surveyOffer() {
        ensureLife();
        if (player == null || direct != null || surveyActive != null || !dry() || !body.dryRouteView()) return noSurvey();
        BlockPos from = player.getBlockPos();
        Direction bearing = player.getHorizontalFacing();
        if (!directSourceContact(from, bearing)) return noSurvey();
        BlockPos to = from.offset(bearing).down();
        if (examinedLips.size() >= SURVEY_LANES || examinedLips.containsKey(new SurveyLane(from, bearing))) return noSurvey();
        int now = body.actionTick();
        long frame = body.renderedFrame();
        if (now == surveyReadAt && frame == surveyReadFrame && from.equals(surveySource) && bearing == surveyBearing)
            return surveyOfferedAt == now ? surveyOffered : null;
        surveyReadAt = now;
        surveyReadFrame = frame;
        surveySource = from;
        surveyBearing = bearing;
        Probe probe = selectedProbe(from, to);
        sampleEdge(probe);
        Vec3d missing = probe.lowerGlance(now);
        if (missing == null || body.dryRoutePointInView(missing)) return noSurvey();
        BlockHitResult lower = body.find(drySurveyBlock, 4, drySurveyFace).orElse(null);
        if (lower == null) return noSurvey();
        if (surveyOffered == null || !surveyOffered.from.equals(from)
                || !surveyOffered.to.equals(to)
                || player.getPos().squaredDistanceTo(surveyOfferedFeet) > 0.01
                || !liveSurveyCue(surveyOffered.witness)) {
            Vec3d delta = missing.subtract(player.getEyePos());
            // Include the missing low witness near the center of one ordinary
            // downward glance, with room left for the already visible upper lane.
            float pitch = (float) Math.toDegrees(Math.atan2(-delta.y, delta.horizontalLength())) - 13;
            pitch = Math.min(54f, Math.max(27f, pitch));
            Vec3d feet = player.getPos();
            float yaw = bearing.getPositiveHorizontalDegrees();
            for (int i = 0; i < probe.points.length; i++) {
                Vec3d point = probe.points[i];
                if (point != null && !probe.fresh(i, now) && !body.macroRetainsView(point, feet, yaw, pitch))
                    return noSurvey();
            }
            surveyOffered = new Survey(from, to, bearing, lower, pitch);
            surveyOfferedFeet = feet;
        }
        surveyOfferedAt = now;
        return surveyOffered;
    }

    private Survey noSurvey() {
        surveyOffered = null;
        return null;
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
            && player != null && dry() && body.dryRouteView()
            && body.actionTick() - surveyOfferedAt <= OFFER_FRESH_TICKS
            && player.getHorizontalFacing() == authorization.bearing
            && directSourceContact(authorization.from, authorization.bearing)
            && player.getPos().squaredDistanceTo(surveyOfferedFeet) <= 0.01
            && surveyOffer() == authorization;
    }

    SurveyResult surveyDirect(Survey authorization) {
        int now = body.actionTick();
        if (surveyActive == null) {
            if (!surveyCurrent(authorization)) return SurveyResult.REFUSED;
            surveyActive = authorization;
            examinedLips.put(new SurveyLane(authorization.from, authorization.bearing), authorization);
            surveyOffered = null; // No authorization can be replayed after an attempt.
            surveyProbe = selectedProbe(authorization.from, authorization.to);
            surveyFeet = player.getPos();
            surveyStarted = surveyViewedAt = now;
            surveyFrame = -1;
            surveyGeometryChanged = false;
        } else if (surveyActive != authorization || now != surveyLastTick + 1 || !dry()
                || player.getHorizontalFacing() != authorization.bearing
                || !directSourceContact(authorization.from, authorization.bearing)
                || player.getPos().squaredDistanceTo(surveyFeet) > 0.01) {
            return SurveyResult.REFUSED;
        }
        surveyLastTick = now;
        if (surveyGeometryChanged) return SurveyResult.UNPROVED;
        int age = now - surveyStarted;
        if (body.dryRouteView() && body.renderedFrame() > surveyFrame) {
            surveyFrame = body.renderedFrame();
            surveyViewedAt = now;
            observePair(surveyProbe, null, 0);
            if (surveyGeometryChanged) return SurveyResult.UNPROVED;
            if (paired(surveyProbe) && graph.refreshReturn(authorization.from.asLong())
                    && graph.canReturn(authorization.to.asLong())) {
                surveyed = surveyProbe;
                surveyedAt = now;
                offerReadAt = -1;
                return SurveyResult.PAIRED;
            }
            if (surveyProbe.failure != null || surveyProbe.floorEvidence == AgentBody.DryRouteTop.NO_FULL_TOP
                    || body.renderedDirection(
                    authorization.bearing.getPositiveHorizontalDegrees(), authorization.pitch, 5))
                return SurveyResult.UNPROVED;
        }
        if (now - surveyViewedAt > 2) return SurveyResult.REFUSED;
        if (age >= VIEW_TICKS) return surveyFrame >= 0 ? SurveyResult.UNPROVED : SurveyResult.REFUSED;
        if (body.dryRouteView()) body.turnFixed(authorization.bearing.getPositiveHorizontalDegrees(), authorization.pitch);
        return SurveyResult.RUNNING;
    }

    String surveyEvidence(Survey authorization) {
        if (authorization != surveyActive || surveyProbe == null) return "view unavailable";
        return surveyGeometryChanged ? "the exact lip geometry changed during the glance" : surveyProbe.evidence();
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
        return offerStance(source) && AgentBody.drySurveyLaneCentered(source, player.getX(), player.getZ(), facing);
    }

    private boolean sameOfferSource(BlockPos source) {
        return source.equals(offered.from) && player.getPos().squaredDistanceTo(offeredFeet) <= 0.01;
    }

    DirectResult follow(Offer authorization, int tick, Consumer<AgentSurfaceTread.Edge> landed) {
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
            if (!stopDirectAfterArrival && graph.topologyEpoch() != offeredTopology) {
                long from = directHop == 0 ? direct.from.asLong() : offeredHops[directHop - 1];
                if (!graph.revalidateDirectSuffix(from, offeredHops, directHop, offeredCount)) {
                    if (!moving || edge == null || !paired(edge) || !graph.refreshReturn(edge.to.asLong()))
                        return directRefusal("the pinned directed route or its proved return changed");
                    // Losing a later row must not cut off an otherwise safe current landing.
                    stopDirectAfterArrival = true;
                }
                offeredTopology = graph.topologyEpoch();
            }
        }
        lastTurn = now;
        directLanded = landed;
        if (edge == null) {
            BlockPos from = directHop == 0 ? direct.from : BlockPos.fromLong(offeredHops[directHop - 1]);
            BlockPos to = BlockPos.fromLong(offeredHops[directHop]);
            if (directHop == 0 ? !sameOfferSource(from) || !directSourceContact(from, bearing(from, to))
                    : !settled(from, 0.22)) return directRefusal("did not remain on the authorized support");
            if (!graph.revalidateDirectSuffix(from.asLong(), offeredHops, directHop, offeredCount))
                return directRefusal("the exact next edge or its proved return path changed");
            edge = selectedProbe(from, to);
            since = tick;
            activity = "dry route selected: authorized return-connected segment to " + at(endpoint)
                + "; next " + at(from) + " -> " + at(to);
            directReason = "checking the authorized next edge";
        }
        if (moving) drive(tick);
        else {
            if (directHop == 0 && !sameOfferSource(edge.from))
                return directRefusal("actual source changed while revalidating the selected edge");
            validate(tick, player.getBlockPos());
        }
        if (yieldRefusal) {
            clearDirect();
            return DirectResult.REFUSED;
        }
        if (edge == null && stopDirectAfterArrival)
            return directRefusal("settled on the last verified support; the pinned next leg changed");
        if (directHop == offeredCount) {
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
        directLanded = null;
        stopDirectAfterArrival = false;
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
        }
        if (surveyOffered != null && (player == null || !dry() || !offerStance(surveyOffered.from)
                || player.getPos().squaredDistanceTo(surveyOfferedFeet) > 0.01)) surveyOffered = null;
        if (surveyed != null && (player == null || !dry() || !player.getBlockPos().equals(surveyed.from))) surveyed = null;
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
        invalidateObservation(changed);
        if (moving && edge != null && edge.touches(changed))
            refuse(Retirement.OBSTRUCTION, "geometry changed during the selected sweep");
    }

    private void invalidateObservation(BlockPos changed) {
        offerReadAt = surveyReadAt = -1;
        for (Probe probe : probes) if (probe != null && probe.touches(changed)) probe.reset();
        if (surveyed != null && surveyed.touches(changed)) surveyed = null;
        if (surveyOffered != null && (touches(surveyOffered.from, surveyOffered.to, changed)
                || surveyOffered.witness.getBlockPos().equals(changed))) surveyOffered = null;
        if (surveyActive != null && (touches(surveyActive.from, surveyActive.to, changed)
                || surveyActive.witness.getBlockPos().equals(changed))) surveyGeometryChanged = true;
        examinedLips.values().removeIf(survey -> touches(survey.from, survey.to, changed)
            || survey.witness.getBlockPos().equals(changed));
        if (anchor == null) return;
        for (int i = 0; i < 4; i++) {
            Direction forward = direction(i);
            for (int y = -3; y <= 2; y++) {
                BlockPos here = changed.up(y);
                changeAt(here, i, forward, changed);
                changeAt(here.offset(forward.getOpposite()), i, forward, changed);
            }
        }
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
        offerReadAt = surveyReadAt = -1;
        examinedLips.remove(new SurveyLane(foot, sector));
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
        if (viewAt != null) return survey(current, preferredOre);
        if (edge != null) return validate(tick, current);
        Direction facing = player.getHorizontalFacing();
        if (body.dryRouteView()) {
            if (sampleStrip(current, facing) == 0) {
                Probe down = selectedProbe(current, current.offset(facing).down());
                if (observePair(down, null, 0) == null)
                    observePair(selectedProbe(current, current.offset(facing).up()), null, 0);
            }
        }
        long cell = current.asLong();
        AgentRouteGraph.Status result = graph.plan(cell);
        if (result != AgentRouteGraph.Status.LIMIT) limitedAt = null;
        return switch (result) {
            case MOVE -> {
                BlockPos next = BlockPos.fromLong(graph.next());
                endpoint = BlockPos.fromLong(graph.endpoint());
                edge = selectedProbe(current, next);
                plannedAhead = graph.segmentCell(1);
                since = tick;
                activity = "dry route selected: " + (endpoint.getY() < current.getY() ? "lower" : "unexamined")
                    + " return-connected frontier " + at(endpoint)
                    + "; next " + at(current) + " -> " + at(next);
                yield validate(tick, current);
            }
            case FRONTIER -> {
                int index = graph.frontierBearing();
                if (!body.dryRouteView() || index < 0 || direction(index) != facing)
                    yield noRoute("the next unwitnessed frontier is outside the current bearing");
                startView(current, index);
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

    private void startView(BlockPos current, int index) {
        viewAt = current;
        unprovedAt = lightAt = null;
        viewIndex = index;
        bearing = direction(index);
        apertureChecked = false;
        activity = "dry route reading the current " + bearing + " view from " + at(current);
    }

    private boolean survey(BlockPos current, Predicate<BlockState> preferredOre) {
        if (!current.equals(viewAt) || !body.dryRouteView() || player.getHorizontalFacing() != bearing) {
            interrupt();
            return noRoute("the source or its rendered bearing changed before observation");
        }
        if (preferredOre == null) lava = body.visibleFluid(true, true, 14);
        else ore = body.find(preferredOre, 12, hit -> !hit.getBlockPos().equals(current.down())
            && player.getEyePos().squaredDistanceTo(hit.getPos()) <= 3.9 * 3.9).orElse(null);
        graph.consumeFrontier(current.asLong(), viewIndex);
        clearView();
        if (ore != null || lava != null) {
            activity = "dry route view exposed reachable objective work";
            return false;
        }
        boolean proved = false;
        for (int i = 0; i < candidates.length; i++) {
            Probe candidate = selectedProbe(current, current.offset(bearing).up(i - 1));
            candidates[i] = candidate;
            proved |= observePair(candidate, null, 0) != null;
        }
        if (!proved) {
            unprovedAt = current;
            unprovedBearing = bearing;
            Probe drop = candidates[0];
            if (drop.failure != Retirement.HAZARD && drop.failure != Retirement.OBSTRUCTION
                    && (drop.floorEvidence == AgentBody.DryRouteTop.DARK
                        || drop.floorEvidence == AgentBody.DryRouteTop.NO_FULL_TOP && drop.hasHeadroom(body.actionTick()))) {
                lightAt = current;
                lightBearing = bearing;
            }
        }
        activity = "dry route view result: " + at(current) + " " + bearing
            + "; down=" + candidates[0].evidence() + "; level=" + candidates[1].evidence()
            + "; up=" + candidates[2].evidence();
        return true;
    }

    private Probe selectedProbe(BlockPos from, BlockPos to) {
        Probe found = findProbe(from, to);
        if (found != null) return found;
        while (probes[probeCursor] != null
                && (probes[probeCursor] == edge || probes[probeCursor] == surveyProbe || probes[probeCursor] == surveyed)) {
            probeCursor = (probeCursor + 1) % probes.length;
        }
        Probe probe = new Probe(from, to, bearing(from, to));
        probes[probeCursor] = probe;
        probeCursor = (probeCursor + 1) % probes.length;
        return probe;
    }

    private Probe findProbe(BlockPos from, BlockPos to) {
        for (Probe probe : probes) if (probe != null && probe.from.equals(from) && probe.to.equals(to)) return probe;
        return null;
    }

    /** Sample a near-to-far cardinal run from the same render; stop at the first unknown edge. */
    private int sampleStrip(BlockPos source, Direction forward) {
        if (!body.dryRouteView()) return 0;
        int now = body.actionTick();
        int count = 0, sourceTick = 0;
        BlockState sourceState = null;
        BlockPos from = source;
        for (; count < STRIP_EDGES; count++) {
            Probe probe = selectedProbe(from, from.offset(forward));
            Probe proof;
            if (count == 0 || body.dryRouteHorizonRoom()) {
                proof = observePair(probe, sourceState, sourceTick);
            } else {
                // Reserve live rays for the imminent sweep and pickup checks.
                // A still-current pair can remain in the strip without a new cast.
                proof = currentProof(probe);
                if (proof != null && (!graph.usable(probe.from.asLong(), probe.to.asLong())
                        || !graph.usable(probe.to.asLong(), probe.from.asLong()) || !negativeTransitVetoesClear(probe))) {
                    proof = null;
                }
            }
            if (proof == null) break;
            if (proof == probe) {
                sourceState = probe.floorState(now);
                sourceTick = probe.seen[Probe.FLOOR];
            } else {
                sourceState = proof.states[Probe.SOURCE];
                sourceTick = proof.seen[Probe.SOURCE];
            }
            from = probe.to;
        }
        return count;
    }

    private Probe observePair(Probe probe, BlockState sourceState, int sourceTick) {
        sampleEdge(probe, sourceState, sourceTick);
        Probe proof = currentProof(probe);
        if (proof != null && !negativeTransitVetoesClear(probe)) probe.failure = Retirement.OBSTRUCTION;
        long from = probe.from.asLong(), to = probe.to.asLong();
        if (probe.failure != null) {
            graph.retire(from, to, probe.failure);
            graph.retire(to, from, probe.failure);
            return null;
        }
        if (proof == null) return null;
        if (anchor == null) startGraph(probe.from, probe.bearing);
        if (admit(probe.from, probe.to) | admit(probe.to, probe.from)) {
            register(probe.to);
            surveyEvidence++;
        }
        return graph.usable(from, to) && graph.usable(to, from) ? proof : null;
    }

    private void sampleEdge(Probe probe) { sampleEdge(probe, null, 0); }

    private void sampleEdge(Probe probe, BlockState sourceState, int sourceTick) {
        if (!body.dryRouteView()) return;
        int now = body.actionTick();
        unchanged(probe, now);
        if (sourceState == null && settled(probe.from, 0.27) && player.getPose() == EntityPose.STANDING) {
            sourceState = body.dryCaveContact(probe.from);
            sourceTick = now;
        }
        probe.sample(probeView, now, body.renderedFrame(), sourceState, sourceTick);
    }

    /** The inverse of a geometry-proved pair is evidence, not an assumed reverse walk. */
    private Probe currentProof(Probe probe) {
        int now = body.actionTick();
        if (probe.failure != null) return null;
        Probe proof = probe.complete(now) ? probe : findProbe(probe.to, probe.from);
        if (proof == null || !proof.complete(now)) return null;
        return unchanged(proof, now) ? proof : null;
    }

    private boolean unchanged(Probe probe, int now) {
        if (probe.lastStateCheck == now) return true;
        BlockPos altered = probe.changedWitness(probeView);
        if (altered != null) {
            invalidateObservation(altered);
            return false;
        }
        probe.lastStateCheck = now;
        return true;
    }

    private boolean paired(Probe probe) {
        return currentProof(probe) != null && graph.usable(probe.from.asLong(), probe.to.asLong())
            && graph.usable(probe.to.asLong(), probe.from.asLong());
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
        sampleEdge(edge);
        if (edge.failure == Retirement.OBSTRUCTION || edge.failure == Retirement.HAZARD) {
            refuse(edge.failure, "current camera blocks the selected edge: " + edge.evidence());
        } else if (body.dryRouteView() && paired(edge)) {
            if (!sweepRefused() && allowsDirectMovement()) {
                moving = true;
                since = tick;
                missingDriveViews = 0;
                if (direct != null) directReason = "traversing the revalidated authorized edge";
                activity = "dry route revalidated " + at(edge.from) + " -> " + at(edge.to)
                    + "; held frontier " + at(endpoint);
                advanceDrive(tick);
            }
        } else if (body.dryRouteView() || tick - since >= 2) {
            refuse(edge.failure == Retirement.LIGHT ? Retirement.LIGHT : Retirement.OBSERVATION,
                "fresh lit forward/return evidence unavailable: " + edge.evidence());
        }
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
        if (tick - since > DRIVE_TICKS) {
            refuse(Retirement.EXECUTION, "traversal did not settle on the selected support");
        } else {
            sampleEdge(edge);
            if (edge.failure != null || !paired(edge))
                refuse(edge.failure == null ? Retirement.OBSERVATION : edge.failure,
                    "the forward and reverse corridor lost its witness");
            else if (allowsDirectMovement()) advanceDrive(tick);
        }
        return true;
    }

    private void advanceDrive(int tick) {
        BlockState source = driveFooting(edge.from), landing = driveFooting(edge.to);
        if (driveSource == null) {
            driveSource = source;
            driveLanding = landing;
            startDriveMotion();
        }
        if (driveSource != source || driveLanding != landing || !body.walkedLaneDry(edge.from, edge.to, edge.bearing)
                || !AgentSurfaceTread.reverseClear(client, edge.from, edge.to, edge.bearing)) {
            refuse(Retirement.OBSTRUCTION, "the exact support or reverse clearance changed during traversal");
            return;
        }
        Probe next = continuation();
        if (!graph.usable(edge.from.asLong(), edge.to.asLong()) || !graph.usable(edge.to.asLong(), edge.from.asLong())) {
            refuse(Retirement.OBSERVATION, "the selected edge lost its witness while looking ahead");
            return;
        }
        double remaining = (edge.to.getX() + 0.5 - player.getX()) * edge.bearing.getOffsetX()
            + (edge.to.getZ() + 0.5 - player.getZ()) * edge.bearing.getOffsetZ();
        boolean atWaypoint = settled(edge.to, 0.22);
        if (atWaypoint && !driveMotion.traversed()) {
            refuse(Retirement.EXECUTION, "ground contact lacks a contiguous traversal");
            return;
        }
        if (atWaypoint && (next != null && AgentBody.dryStrideContact(remaining)
                || player.getVelocity().horizontalLengthSquared() <= 0.0025)) finishDrive(tick, next);
        else body.driveDryRoute(edge.from, edge.to, edge.bearing, next != null);
    }

    private Probe continuation() {
        if (edge.from.getY() != edge.to.getY() || !AgentBody.normalDryTraction(driveSource)
                || !player.isOnGround() || stopDirectAfterArrival) return null;
        long target = direct != null
            ? directHop + 1 < offeredCount ? offeredHops[directHop + 1] : AgentRouteGraph.NO_CELL
            : plannedAhead;
        if (target == AgentRouteGraph.NO_CELL) return null;
        BlockPos nextFoot = edge.to.offset(edge.bearing);
        if (nextFoot.asLong() != target) return null;
        // Only a pinned successor can receive input, even if this view exposes more of the cave.
        sampleStrip(player.getBlockPos(), edge.bearing);
        Probe next = selectedProbe(edge.to, nextFoot);
        if (!paired(next) || !graph.refreshReturn(target)
                || direct != null && !graph.revalidateDirectSuffix(edge.to.asLong(), offeredHops, directHop + 1, offeredCount)
                || !body.dryRouteContinuationClear(next.from, next.to, next.bearing, driveLanding,
                    driveFooting(next.to))
                || direct != null && !directPickupClear(next)) return null;
        return next;
    }

    private void finishDrive(int tick, Probe next) {
        Probe arrived = edge;
        walked(arrived.from, arrived.to);
        reached.accept(arrived.from, arrived.to);
        if (direct != null) {
            if (directLanded != null)
                directLanded.accept(new AgentSurfaceTread.Edge(arrived.from, driveSource, arrived.to, driveLanding, arrived.bearing));
            ++directHop;
        }
        activity = "dry route " + (next != null ? "grounded stride through " : "settled arrival ")
            + at(arrived.to) + "; committed frontier " + at(endpoint);
        edge = next;
        moving = next != null;
        driveSource = null;
        if (next == null) return;
        if (direct == null) {
            plannedAhead = graph.plan(arrived.to.asLong()) == AgentRouteGraph.Status.MOVE && graph.next() == next.to.asLong()
                ? graph.segmentCell(1) : AgentRouteGraph.NO_CELL;
        }
        since = tick;
        startDriveMotion();
        // The successor is already validated for this input. Sample its own successor
        // on the next tick, while still well inside the newly selected lane.
        driveSource = driveLanding;
        driveLanding = driveFooting(next.to);
        body.driveDryRoute(next.from, next.to, next.bearing);
    }

    private BlockState driveFooting(BlockPos foot) {
        return world.getBlockState(driveSupport.set(foot).move(Direction.DOWN));
    }

    private void startDriveMotion() {
        driveMotion.start(player.getX(), player.getY(), player.getZ());
    }

    private boolean observeDriveMotion() {
        return driveMotion.observe(player.getX(), player.getY(), player.getZ());
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
        driveSource = null;
        yieldRefusal = true;
        graph.cancelPlan();
    }

    private boolean allowsDirectMovement() {
        if (direct == null || directPickupClear(edge)) return true;
        directReason = "visible pickup or lost pickup clearance on the authorized sweep";
        activity = "dry route refused: " + directReason;
        edge = null;
        moving = false;
        driveSource = null;
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
        offerReadAt = surveyReadAt = -1;
        Arrays.fill(probes, null);
        probeCursor = 0;
        unprovedAt = lightAt = null;
        direct = offered = null;
        directLanded = null;
        stopDirectAfterArrival = false;
        surveyOffered = surveyActive = null;
        examinedLips.clear();
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
        edge = null;
        endpoint = null;
        moving = false;
        driveSource = null;
        plannedAhead = AgentRouteGraph.NO_CELL;
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

    private static String at(BlockPos foot) { return foot.toShortString(); }

    private static boolean touches(BlockPos from, BlockPos to, BlockPos changed) {
        int y = changed.getY();
        return (from.getX() == changed.getX() && from.getZ() == changed.getZ()
            || to.getX() == changed.getX() && to.getZ() == changed.getZ())
            && y >= Math.min(from.getY(), to.getY()) - 1 && y <= Math.max(from.getY(), to.getY()) + 2;
    }

    interface ProbeView {
        AgentBody.DryRouteTop top(Vec3d point, BlockPos support);
        AgentBody.DryRouteSample space(Vec3d point);
        /** Used only to record a positive ray/contact or to invalidate previously admitted evidence. */
        BlockState state(BlockPos pos);
    }

    static final class Probe {
        private static final int FLOOR = 0, SOURCE = 1, SHIN = 2, HEAD = 3, LEFT = 4, RIGHT = 5,
            ENTRY_LOW = 6, ENTRY_HIGH = 7, TAKEOFF = 8, SAMPLE_COUNT = 9;
        private static final String[] AREAS = {"footing", "return footing", "lower clearance", "headroom",
            "left width", "right width", "low entry", "high entry", "reverse takeoff"};
        private final BlockPos from, to;
        private final Direction bearing;
        private final Vec3d[] points;
        private final Vec3d alternateFloor;
        private final BlockPos[] observedCells = new BlockPos[SAMPLE_COUNT];
        private final BlockState[] states = new BlockState[SAMPLE_COUNT];
        private final int[] seen = new int[SAMPLE_COUNT];
        private final AgentBody.DryRouteSample[] spaces = new AgentBody.DryRouteSample[SAMPLE_COUNT];
        private long lastFrame = -1;
        private int lastSample, lastStateCheck = -1, lastTransitCheck = -1;
        private boolean transitClear;
        private Retirement failure;
        private AgentBody.DryRouteTop floorEvidence = AgentBody.DryRouteTop.OUT_OF_VIEW;

        Probe(BlockPos from, BlockPos to, Direction bearing) {
            this.from = from;
            this.to = to;
            this.bearing = bearing;
            Vec3d source = Vec3d.ofBottomCenter(from), landing = Vec3d.ofBottomCenter(to);
            double x = bearing.getOffsetX(), z = bearing.getOffsetZ();
            double rise = landing.y - source.y, upper = Math.max(landing.y, source.y);
            alternateFloor = landing.add(x * 0.15, -0.025, z * 0.15);
            Vec3d entry = new Vec3d(landing.x - x * 0.27, upper, landing.z - z * 0.27);
            Vec3d lower = rise < 0 ? landing : source;
            double lowerAhead = rise < 0 ? -0.27 : 0.45;
            // A slightly downward walking view contains the far half of the
            // adjacent tread and its lower clearance; it need not center either.
            points = new Vec3d[] {landing.add(x * 0.46, -0.025, z * 0.46), null,
                landing.add(x * 0.45, 0.22, z * 0.45), landing.add(0, 1.76, 0),
                landing.add(z * 0.34, 0.94, -x * 0.34), landing.add(-z * 0.34, 0.94, x * 0.34),
                entry.add(z * 0.34, 0.94, -x * 0.34), entry.add(-z * 0.34, 1.70, x * 0.34),
                rise == 0 ? null : lower.add(x * lowerAhead, 2.76, z * lowerAhead)};
            observedCells[FLOOR] = to.down();
            observedCells[SOURCE] = from.down();
            for (int i = SHIN; i < SAMPLE_COUNT; i++)
                if (points[i] != null) observedCells[i] = BlockPos.ofFloored(points[i]);
        }

        void reset() {
            Arrays.fill(states, null);
            Arrays.fill(spaces, null);
            lastFrame = -1;
            lastStateCheck = lastTransitCheck = -1;
            floorEvidence = AgentBody.DryRouteTop.OUT_OF_VIEW;
            failure = null;
        }

        boolean complete(int now) {
            if (failure != null) return false;
            for (int i = 0; i < SAMPLE_COUNT; i++)
                if (required(i) && !fresh(i, now)) return false;
            return true;
        }

        private boolean required(int sample) {
            // Level travel must still pass the exact standing sweep both ways.
            // Only stairs need positive visual evidence of the upper clearance.
            return observedCells[sample] != null
                && (from.getY() != to.getY() || (sample != HEAD && sample != ENTRY_HIGH));
        }

        boolean hasHeadroom(int now) { return fresh(HEAD, now); }
        boolean visiblyRefused() { return failure != null; }

        private boolean fresh(int sample, int now) {
            return states[sample] != null && now - seen[sample] <= WITNESS_TICKS;
        }

        private boolean touches(BlockPos changed) { return AgentDryCaveRoute.touches(from, to, changed); }

        BlockState floorState(int now) { return fresh(FLOOR, now) ? states[FLOOR] : null; }
        int floorSeenAt() { return seen[FLOOR]; }

        BlockPos changedWitness(ProbeView view) {
            for (int i = 0; i < SAMPLE_COUNT; i++)
                if (states[i] != null && view.state(observedCells[i]) != states[i]) return observedCells[i];
            return null;
        }

        void sample(ProbeView view, int now, long frame, BlockState sourceState, int sourceTick) {
            lastSample = now;
            // Actual contact or the previous pair's observed landing is a
            // separate reverse top witness. Propagating it cannot refresh its age.
            if (sourceState != null && (states[SOURCE] == null || sourceTick >= seen[SOURCE])) {
                states[SOURCE] = sourceState;
                seen[SOURCE] = sourceTick;
            }
            if (frame == lastFrame) return;
            lastFrame = frame;
            BlockPos support = observedCells[FLOOR];
            AgentBody.DryRouteTop top = view.top(points[FLOOR], support);
            if (top != AgentBody.DryRouteTop.WITNESSED && top != AgentBody.DryRouteTop.FLUID) {
                AgentBody.DryRouteTop other = view.top(alternateFloor, support);
                if (other == AgentBody.DryRouteTop.WITNESSED || top == AgentBody.DryRouteTop.OUT_OF_VIEW
                        || other == AgentBody.DryRouteTop.FLUID) top = other;
            }
            if (top != AgentBody.DryRouteTop.OUT_OF_VIEW) floorEvidence = top;
            switch (top) {
                case WITNESSED -> witness(FLOOR, view, now);
                case FLUID, NO_FULL_TOP, DARK, UNSUITABLE_TOP -> states[FLOOR] = null;
                default -> { } // Occlusion doesn't add or extend evidence.
            }
            failure = switch (floorEvidence) {
                case FLUID, UNSUITABLE_TOP -> Retirement.HAZARD;
                case DARK -> Retirement.LIGHT;
                default -> null;
            };
            for (int i = SHIN; i < SAMPLE_COUNT; i++) {
                if (points[i] == null) continue;
                AgentBody.DryRouteSample sample = view.space(points[i]);
                if (sample != AgentBody.DryRouteSample.UNKNOWN) spaces[i] = sample;
                if (sample == AgentBody.DryRouteSample.CLEAR) witness(i, view, now);
                else if (sample != AgentBody.DryRouteSample.UNKNOWN) states[i] = null;
                if (spaces[i] == AgentBody.DryRouteSample.FLUID) failure = Retirement.HAZARD;
                else if (spaces[i] == AgentBody.DryRouteSample.OBSTRUCTION && failure != Retirement.HAZARD)
                    failure = Retirement.OBSTRUCTION;
                else if (spaces[i] == AgentBody.DryRouteSample.DARK && failure == null)
                    failure = Retirement.LIGHT;
            }
        }

        private void witness(int sample, ProbeView view, int now) {
            states[sample] = view.state(observedCells[sample]);
            seen[sample] = now;
        }

        private Vec3d lowerGlance(int now) {
            if (failure != null || !fresh(SOURCE, now) || !fresh(HEAD, now) || !fresh(TAKEOFF, now)) return null;
            if (!fresh(FLOOR, now) && floorEvidence == AgentBody.DryRouteTop.OUT_OF_VIEW) return points[FLOOR];
            if (!fresh(SHIN, now) && spaces[SHIN] == null) return points[SHIN];
            return null;
        }

        String evidence() {
            if (complete(lastSample)) return "forward and return witnessed";
            StringBuilder gaps = new StringBuilder();
            for (int i = 0; i < SAMPLE_COUNT; i++) {
                if (observedCells[i] == null || fresh(i, lastSample)
                        || !required(i) && (spaces[i] == null || spaces[i] == AgentBody.DryRouteSample.CLEAR)) continue;
                if (!gaps.isEmpty()) gaps.append(", ");
                gaps.append(AREAS[i]).append(':');
                if (states[i] != null) gaps.append("expired");
                else if (i == FLOOR) gaps.append(floorEvidence);
                else gaps.append(spaces[i] == null ? "unwitnessed" : spaces[i]);
            }
            return gaps.isEmpty() ? "exact transit veto: " + failure : gaps.toString();
        }
    }
}
