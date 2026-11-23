package io.gameharness.survival;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Predicate;
import java.util.function.ToDoubleFunction;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Owns the work exclusion, walked retreat legs, and physical premises of refused exits. */
final class AgentSupplyEgress {
    static final double LIGHT_REACH = 2.6;
    private static final int MAX_WALKED_LEGS = 96, MAX_RETURN_LEGS = 8, MAX_REFUSALS = 32;
    private static final int MAX_FLOODS = 6, FLOOD_TICKS = 1200;
    private static final int ASCENT_HANDOFF_TICKS = 18;

    private record Refusal(String detail, Set<BlockPos> cells, BlockPos floodPremise) {}
    private record Leg(BlockPos from, BlockPos to) {
        BlockPos other(BlockPos end) {
            return from.equals(end) ? to : to.equals(end) ? from : null;
        }
    }
    private record ReturnNode(BlockPos foot, ReturnNode nearerLip, int depth) {}
    private record Flood(BlockPos lip, BlockPos opening, BlockPos water, boolean source, int tick) {
        boolean near(BlockPos cell) {
            return near(lip, cell) || near(opening, cell) || near(water, cell);
        }

        private static boolean near(BlockPos origin, BlockPos cell) {
            return origin != null && Math.abs(origin.getX() - cell.getX()) <= 2
                && Math.abs(origin.getY() - cell.getY()) <= 2 && Math.abs(origin.getZ() - cell.getZ()) <= 2;
        }
    }

    /** Oldest to newest; an arrival inside the flood neighborhood is not the end of the retreat. */
    record FloodRetreat(List<BlockPos> walked, Flood flood) {
        boolean outsideFlood(BlockPos standing) { return !flood.near(standing); }

        FloodRetreat afterDryLanding(BlockPos standing) {
            if (outsideFlood(standing)) return null;
            int index = walked.lastIndexOf(standing);
            return index > 0 && index < walked.size() - 1
                ? new FloodRetreat(walked.subList(0, index + 1), flood) : null;
        }
    }

    private final LinkedHashMap<BlockPos, Refusal> refusals = new LinkedHashMap<>();
    private final Set<BlockPos> checked = new HashSet<>();
    private final ArrayDeque<Leg> walked = new ArrayDeque<>();
    private final ArrayDeque<Flood> floods = new ArrayDeque<>();
    private BlockPos foot, floodPremise, witnessedLanding;
    private BlockState landingSupport, carriedSupport;
    private Direction ascentBearing;
    private int ascentUntil;
    private boolean airborneHold, carriedSupportLost;

    BlockPos foot() { return foot; }
    boolean active() { return foot != null; }

    /** A trunk above the mouth of a shaft is a landmark, not collected supplies. */
    static boolean timberAtTread(int feetY, int logY) {
        return logY >= feetY && logY <= feetY + 1;
    }

    static BlockHitResult closestLightFace(BlockHitResult selected, BlockHitResult[] samples, int count,
                                           ToDoubleFunction<BlockHitResult> score) {
        BlockHitResult best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (int i = -1; i < count; i++) {
            BlockHitResult hit = i < 0 ? selected : samples[i];
            if (hit == null) continue;
            double cost = score.applyAsDouble(hit);
            if (cost < bestScore) {
                best = hit;
                bestScore = cost;
            }
        }
        return best;
    }

    static double lightFaceScore(BlockHitResult hit, Vec3d eye, float yaw, BlockPos from, BlockPos to,
                                 Direction lane, Vec3d dark) {
        Direction side = hit.getSide();
        Vec3d point = hit.getPos();
        double range = point.squaredDistanceTo(eye);
        if (hit.isInsideBlock() || side == Direction.DOWN || range > LIGHT_REACH * LIGHT_REACH)
            return Double.POSITIVE_INFINITY;
        BlockPos site = hit.getBlockPos().offset(side);
        if (sameColumn(site, from) && site.getY() >= from.getY() - 1 && site.getY() <= from.getY() + 3) {
            // The non-colliding wall torch can hug a flank at standing eye height.
            // Keep the tread, the crown and all landing probes free of a torch.
            if (site.getY() != from.getY() + 1 || !side.getAxis().isHorizontal() || side.getAxis() == lane.getAxis())
                return Double.POSITIVE_INFINITY;
        }
        if ((to != null && sameColumn(site, to) && site.getY() >= to.getY() - 1 && site.getY() <= to.getY() + 2)
                || dark.squaredDistanceTo(site.getX() + 0.5, site.getY() + 0.5, site.getZ() + 0.5) > 9)
            return Double.POSITIVE_INFINITY;
        float targetYaw = (float) Math.toDegrees(Math.atan2(eye.x - point.x, point.z - eye.z));
        return Math.abs(MathHelper.wrapDegrees(targetYaw - yaw)) + 0.001 * range;
    }

    private static boolean sameColumn(BlockPos a, BlockPos b) {
        return a.getX() == b.getX() && a.getZ() == b.getZ();
    }

    boolean holdOrdinary(boolean airborne) {
        if (!airborne) airborneHold = false;
        return airborneHold;
    }

    String refusal(BlockPos standing, int tick) {
        var refusal = refusals.get(standing);
        if (refusal == null) return null;
        if (refusal.floodPremise() != null && !blocksFloodWork(refusal.floodPremise(), tick)) {
            refusals.remove(standing);
            return null;
        }
        return refusal.detail();
    }

    boolean begin(BlockPos standing, boolean grounded, int tick) {
        if (!grounded || active() || refusal(standing, tick) != null || blocksFloodWork(standing, tick)) return false;
        landed(standing);
        return true;
    }

    void landed(BlockPos standing) {
        standing = standing.toImmutable();
        if (foot != null && Math.abs(foot.getX() - standing.getX()) + Math.abs(foot.getZ() - standing.getZ()) == 1
                && Math.abs(foot.getY() - standing.getY()) <= 1) {
            Leg leg = new Leg(foot, standing);
            walked.removeIf(prior -> leg.to().equals(prior.other(leg.from())));
            if (walked.size() == MAX_WALKED_LEGS) walked.removeFirst();
            walked.addLast(leg);
        }
        foot = standing;
        floodPremise = null;
        forgetLanding();
        forgetSupport();
        checked.clear();
        checked.add(standing.down());
    }

    void witnessLanding(BlockPos to, BlockState observed) {
        if (active() && observed != null) {
            witnessedLanding = to.toImmutable();
            landingSupport = observed;
        }
    }

    BlockState landingSupport(BlockPos to) {
        return to.equals(witnessedLanding) ? landingSupport : null;
    }

    void forgetLanding() {
        witnessedLanding = null;
        landingSupport = null;
    }

    /** A render witness is only promoted by matching, settled vanilla contact. */
    boolean landWitnessed(BlockPos to, BlockState contact, int tick, boolean continueAscent) {
        if (contact == null || contact != landingSupport(to)) return false;
        Direction travel = AgentDryLanding.bearing(foot, to);
        if (travel == null || !AgentSurfaceTread.cardinalTread(foot, to, travel)) return false;
        boolean rising = to.getY() > foot.getY();
        landed(to);
        carriedSupport = contact;
        if (rising && continueAscent) {
            ascentBearing = travel;
            ascentUntil = tick + ASCENT_HANDOFF_TICKS;
        }
        return true;
    }

    BlockState carriedSupport() { return carriedSupport; }

    void observeSupport(BlockState actualContact) {
        if (carriedSupport != null && carriedSupport != actualContact) carriedSupportLost = true;
    }

    boolean retainSupport() {
        if (carriedSupport == null || carriedSupportLost) {
            forgetSupport();
            return false;
        }
        return true;
    }

    BlockState crossingSourceSupport() { return carriedSupportLost ? null : carriedSupport; }

    Direction ascentBearing(int tick) { return !carriedSupportLost && tick < ascentUntil ? ascentBearing : null; }

    void endAscentHandoff() { ascentBearing = null; }

    void forgetSupport() {
        carriedSupport = null;
        carriedSupportLost = false;
        endAscentHandoff();
    }

    BlockPos previousLevelFoot(BlockPos standing) {
        for (Leg leg : walked.reversed())
            if (leg.to().equals(standing) && leg.from().getY() == standing.getY()) return leg.from();
        return null;
    }

    void considered(BlockPos cell) { checked.add(cell); }

    void observeBreak(BlockPos cell) {
        if (witnessedLanding != null && witnessedLanding.equals(cell.up())) forgetLanding();
        if (carriedSupport != null && foot.equals(cell.up())) carriedSupportLost = true;
        if (!refusals.isEmpty()) refusals.values().removeIf(refusal -> refusal.cells().contains(cell));
        if (!walked.isEmpty()) {
            BlockPos above = cell.up();
            walked.removeIf(leg -> leg.other(above) != null);
        }
    }

    boolean blocksFloodWork(BlockPos standing, int tick) {
        expireFloods(tick);
        for (Flood flood : floods) if (flood.near(standing)) return true;
        return false;
    }

    boolean avoidFlood(BlockPos cell, int tick) {
        if (!blocksFloodWork(cell, tick)) return false;
        if (floodPremise == null) floodPremise = cell;
        return true;
    }

    void recheckFloods(BlockPos standing, int tick, Predicate<BlockPos> witnessedDry) {
        expireFloods(tick);
        if (floods.isEmpty()) return;
        // A departed flow front, ordinary block break, or momentarily dry foot is not changed source evidence.
        var refusal = refusals.get(standing);
        BlockPos next = refusal == null ? null : refusal.floodPremise();
        floods.removeIf(flood -> flood.source() && flood.opening() != null
            && (flood.near(standing) || next != null && flood.near(next))
            && witnessedDry.test(flood.water()) && witnessedDry.test(flood.opening()));
    }

    private void expireFloods(int tick) {
        while (!floods.isEmpty() && tick - floods.getFirst().tick() >= FLOOD_TICKS) floods.removeFirst();
    }

    FloodRetreat flood(BlockPos approach, BlockPos opening, BlockPos water, boolean source, int tick) {
        var flood = new Flood(foot, opening != null ? opening : approach, water, source, tick);
        expireFloods(tick);
        if (floods.size() == MAX_FLOODS) floods.removeFirst();
        floods.addLast(flood);
        finish();

        // A new order, or a visit to an unrelated site, never creates a bridging edge.
        // Search actual receipts only, preferring a corridor out of the wet neighborhood.
        var pending = new ArrayDeque<ReturnNode>();
        var reached = new HashSet<BlockPos>();
        var newestFirst = walked.reversed();
        var best = new ReturnNode(flood.lip(), null, 0);
        pending.addLast(best);
        reached.add(best.foot());
        boolean bestNear = true;
        while (!pending.isEmpty()) {
            var node = pending.removeFirst();
            boolean near = flood.near(node.foot());
            if (bestNear && !near || bestNear == near && node.depth() > best.depth()) {
                best = node;
                bestNear = near;
            }
            if (node.depth() == MAX_RETURN_LEGS) continue;
            for (Leg leg : newestFirst) {
                BlockPos next = leg.other(node.foot());
                if (next != null && !next.equals(approach) && !next.equals(opening)
                        && !next.equals(water) && reached.add(next))
                    pending.addLast(new ReturnNode(next, node, node.depth() + 1));
            }
        }
        if (best.depth() == 0) return null;
        var path = new ArrayList<BlockPos>(best.depth() + 1);
        for (var node = best; node != null; node = node.nearerLip()) path.add(node.foot());
        return new FloodRetreat(List.copyOf(path), flood);
    }

    String refuse(String why, boolean airborne) {
        String reason = "supply egress blocked at " + foot.toShortString() + ": " + why;
        refusals.put(foot, new Refusal(reason, Set.copyOf(checked), floodPremise));
        if (refusals.size() > MAX_REFUSALS) refusals.pollFirstEntry();
        finish();
        airborneHold = airborne;
        return reason;
    }

    void finish() {
        foot = floodPremise = null;
        airborneHold = false;
        forgetLanding();
        forgetSupport();
        checked.clear();
    }

    void reset() {
        finish();
        refusals.clear();
        walked.clear();
        floods.clear();
    }

    static boolean naturalDryLeaf(BlockState state) {
        return state.isIn(BlockTags.LEAVES) && state.getFluidState().isEmpty()
            && state.contains(LeavesBlock.PERSISTENT) && !state.get(LeavesBlock.PERSISTENT);
    }

    static boolean canopyContact(BlockState support, boolean bootstrap, boolean returning) {
        return bootstrap && !returning && support != null && naturalDryLeaf(support);
    }

    static boolean canopyLeaf(BlockPos from, Direction lane, BlockHitResult hit, BlockState state, boolean protectedCell) {
        return !protectedCell && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && AgentSurfaceTread.prospectLevelCell(from, hit.getBlockPos(), lane) && naturalDryLeaf(state);
    }

    static boolean canopyTopLeaf(BlockPos from, Direction lane, BlockHitResult hit, BlockState state, boolean protectedCell) {
        return !protectedCell && lane.getAxis().isHorizontal()
            && AgentBody.matchesDryRouteTop(hit, from.offset(lane).down()) && !hit.isInsideBlock()
            && naturalDryLeaf(state);
    }

    /** Budget and physical receipts for a short climb, not a replacement for visual or motor admission. */
    static final class OutlinePassage {
        private static final int TICKS = 900, STEPS = 6, CUTS = 15;
        private static final int APEX_ACCESSES = 2, HAND_CLEARANCES = 2;
        private final Set<BlockPos> visited = new HashSet<>(), attemptedCuts = new HashSet<>();
        private final Set<BlockPos> shiftedApexes = new HashSet<>(), handClearances = new HashSet<>();
        private BlockPos foot, pending;
        private ApexAccess apex;
        private int until;

        boolean active() { return foot != null; }
        boolean withinTime(int tick) { return tick < until; }
        int steps() { return active() ? visited.size() - 1 : 0; }

        boolean canHandoff() { return steps() > 0 && pending == null && apex == null; }

        void begin(BlockPos from, int tick) {
            if (active()) return;
            foot = from.toImmutable();
            visited.add(foot);
            until = tick + TICKS;
        }

        boolean allowsLeg(BlockPos from, BlockPos to) {
            if (apex != null || !from.equals(foot) || steps() >= STEPS || visited.contains(to)) return false;
            int dy = to.getY() - from.getY();
            return dy >= 0 && dy <= 1
                && Math.abs(to.getX() - from.getX()) + Math.abs(to.getZ() - from.getZ()) == 1;
        }

        boolean allowsCut(BlockPos cell) {
            return attemptedCuts.size() < CUTS && !attemptedCuts.contains(cell);
        }

        void attemptedCut(BlockPos cell) { attemptedCuts.add(cell.toImmutable()); }

        boolean allowsHandClearance(BlockPos cell) {
            return handClearances.size() < HAND_CLEARANCES && !handClearances.contains(cell);
        }

        boolean attemptHandClearance(BlockPos cell) {
            return allowsHandClearance(cell) && handClearances.add(cell.toImmutable());
        }

        ApexAccess apexAccess() { return apex; }

        ApexAccess beginApexAccess(BlockPos from, BlockPos rise, BlockHitResult face, BlockState material,
                                   BlockState source, BlockState landing) {
            if (pending != null || rise.getY() != from.getY() + 1 || !allowsLeg(from, rise)
                    || material == null || source == null || landing == null
                    || !AgentSupplyOutline.matchesFace(face, face) || !face.getBlockPos().equals(from.up(3))
                    || shiftedApexes.size() >= APEX_ACCESSES || !shiftedApexes.add(face.getBlockPos().toImmutable()))
                return null;
            return apex = new ApexAccess(foot, rise.toImmutable(), face, material, source, landing);
        }

        boolean finishApexAccess(BlockPos actualSource) {
            if (apex == null || !foot.equals(actualSource)
                    || apex.stage == ApexAccess.Stage.CUT || apex.stage == ApexAccess.Stage.LOOK_BACK
                    || apex.stage == ApexAccess.Stage.WALK_BACK) return false;
            apex = null;
            return true;
        }

        boolean admitLanding(BlockPos from, BlockPos to) {
            if (pending != null || !allowsLeg(from, to)) return false;
            pending = to.toImmutable();
            return true;
        }

        boolean landed(BlockPos actual, boolean settledDryContact) {
            if (!settledDryContact || !actual.equals(pending)) return false;
            foot = pending;
            pending = null;
            visited.add(foot);
            return true;
        }

        void abandonLanding() { pending = null; }

        void reset() {
            foot = pending = null;
            apex = null;
            visited.clear();
            attemptedCuts.clear();
            shiftedApexes.clear();
            handClearances.clear();
            until = 0;
        }
    }

    /** One exact opening and one independently witnessed walking leg there and back. */
    static final class ApexAccess {
        enum Stage { LOOK_SIDE, WALK_OUT, CUT, LOOK_BACK, WALK_BACK, RETURNED }

        final BlockPos source, rise, cell;
        final BlockHitResult face;
        final BlockState sourceSupport, riseSupport;
        private final BlockState material;
        private BlockPos side;
        private BlockState sideSupport;
        private Stage stage = Stage.LOOK_SIDE;
        private boolean requested, opened;

        private ApexAccess(BlockPos source, BlockPos rise, BlockHitResult face, BlockState material,
                           BlockState sourceSupport, BlockState riseSupport) {
            this.source = source;
            this.rise = rise;
            this.face = face;
            cell = face.getBlockPos().toImmutable();
            this.material = material;
            this.sourceSupport = sourceSupport;
            this.riseSupport = riseSupport;
        }

        Stage stage() { return stage; }
        BlockPos side() { return side; }
        BlockState sideSupport() { return sideSupport; }
        boolean opened() { return opened; }

        boolean admitOut(BlockPos target, BlockState support) {
            if (stage != Stage.LOOK_SIDE || support == null || target.getY() != source.getY()
                    || target.equals(rise.down())
                    || Math.abs(target.getX() - source.getX()) + Math.abs(target.getZ() - source.getZ()) != 1)
                return false;
            side = target.toImmutable();
            sideSupport = support;
            stage = Stage.WALK_OUT;
            return true;
        }

        boolean matchesCut(BlockHitResult seen, BlockState state) {
            return stage == Stage.CUT && state == material && AgentSupplyOutline.matchesFace(face, seen);
        }

        void requestedCut() {
            if (stage == Stage.CUT) requested = true;
        }

        boolean broken(BlockPos actual, BlockState state) {
            if (stage != Stage.CUT || !requested || !cell.equals(actual) || material != state) return false;
            opened = true;
            stage = Stage.LOOK_BACK;
            return true;
        }

        void abandonCut() {
            if (stage == Stage.CUT) stage = Stage.LOOK_BACK;
        }

        boolean admitBack() {
            if (stage != Stage.LOOK_BACK) return false;
            stage = Stage.WALK_BACK;
            return true;
        }

        boolean landed(BlockPos standing, boolean settledDryContact) {
            if (!settledDryContact) return false;
            if (stage == Stage.WALK_OUT && side.equals(standing)) stage = Stage.CUT;
            else if (stage == Stage.WALK_BACK && source.equals(standing)) stage = Stage.RETURNED;
            else return false;
            return true;
        }
    }

    /** Keep finite, exact leaf premises separate from a successful cut or a traversed lane. */
    static final class CanopyPassage {
        private static final int MAX_CUTS = 6, MAX_ATTEMPTS = 12, CUTS_AT_SITE = 2, ATTEMPTS_AT_SITE = 3;
        record Candidate(BlockPos foot, Direction bearing, BlockHitResult face, boolean lowerTop) {
            boolean top() { return face.getBlockPos().getY() < foot.getY(); }
            int priority() {
                if (lowerTop) return top() ? 2 : 3;
                return top() ? 1 : 0;
            }
        }

        private static final class Site {
            int attempts, cuts;
        }

        private final Candidate[] branches = new Candidate[Direction.values().length];
        private final Set<BlockPos> attemptedLeaves = new HashSet<>(), walked = new HashSet<>(), worksites = new HashSet<>();
        private final Map<BlockPos, Site> sites = new HashMap<>();
        private BlockPos footing, budgetOrigin, newArrival;
        private Candidate active;
        private long openedFrame = -1;
        private int cuts, attempts;

        boolean available(BlockPos foot, BlockPos leaf) {
            Site site = sites.get(foot);
            return cuts < MAX_CUTS && attempts < MAX_ATTEMPTS && !attemptedLeaves.contains(leaf)
                && (site == null || site.cuts < CUTS_AT_SITE && site.attempts < ATTEMPTS_AT_SITE);
        }

        boolean walkedSupport(BlockPos support) { return walked.contains(support.up()); }

        void landed(BlockPos from, BlockPos to) {
            walked.add(from.toImmutable());
            newArrival = walked.add(to.toImmutable()) ? to.toImmutable() : null;
        }

        void productive(BlockPos foot, BlockPos worksite) {
            // Height changes on one stem, camera rotation and returned footprints do not earn more cuts.
            if (!worksites.add(worksite.withY(0)) || !foot.equals(newArrival) || budgetOrigin == null || active != null)
                return;
            long dx = (long) foot.getX() - budgetOrigin.getX(), dz = (long) foot.getZ() - budgetOrigin.getZ();
            if (dx * dx + dz * dz < 9) return;
            budgetOrigin = foot.toImmutable();
            newArrival = null;
            cuts = attempts = 0;
            Arrays.fill(branches, null);
        }

        void offer(BlockPos foot, Direction lane, BlockHitResult face, boolean lowerTop) {
            if (!available(foot, face.getBlockPos())) return;
            if (!foot.equals(footing)) {
                Arrays.fill(branches, null);
                footing = foot.toImmutable();
            }
            branches[lane.ordinal()] = new Candidate(footing, lane, face, lowerTop);
        }

        Candidate begin(BlockPos foot) {
            if (!foot.equals(footing) || active != null) return null;
            Candidate best = null;
            for (Candidate branch : branches) {
                if (branch == null || !available(foot, branch.face.getBlockPos())) continue;
                if (best == null || branch.priority() > best.priority()) best = branch;
            }
            return take(best);
        }

        Candidate begin(BlockPos foot, Direction lane) {
            return foot.equals(footing) ? take(branches[lane.ordinal()]) : null;
        }

        private Candidate take(Candidate candidate) {
            if (active != null || candidate == null || !available(candidate.foot, candidate.face.getBlockPos())) return null;
            if (budgetOrigin == null) budgetOrigin = candidate.foot;
            walked.add(candidate.foot);
            attemptedLeaves.add(candidate.face.getBlockPos().toImmutable());
            sites.computeIfAbsent(candidate.foot, ignored -> new Site()).attempts++;
            attempts++;
            branches[candidate.bearing.ordinal()] = null;
            return active = candidate;
        }

        Candidate active() { return active; }
        boolean opened() { return openedFrame >= 0; }
        boolean freshOpening(long frame) { return opened() && frame > openedFrame; }
        int cuts() { return cuts; }

        boolean broken(BlockPos leaf, long frame) {
            if (active == null || opened() || !leaf.equals(active.face.getBlockPos())) return false;
            openedFrame = frame;
            cuts++;
            sites.get(active.foot).cuts++;
            return true;
        }

        /** The native grade witness includes both the visible top and the reversible sweep. */
        AgentSurfaceTread.Edge revealedDescent(long frame, AgentSurfaceTread.Edge edge) {
            if (!freshOpening(frame) || active == null || !active.top() || edge == null
                    || !active.foot.equals(edge.upper()) || !active.face.getBlockPos().equals(edge.lower())
                    || active.bearing != edge.down()) return null;
            return edge;
        }

        void finish() {
            active = null;
            openedFrame = -1;
        }

        void reset() {
            finish();
            footing = budgetOrigin = newArrival = null;
            Arrays.fill(branches, null);
            attemptedLeaves.clear();
            walked.clear();
            worksites.clear();
            sites.clear();
            cuts = attempts = 0;
        }
    }

    /** A lit adjacent soil tread and clear passage suffice; a leaf ceiling does not make it a cave. */
    boolean handoffWoodland(AgentDryCaveRoute.ProbeView view, Direction bearing,
                           BiPredicate<BlockPos, Direction> sweepClear) {
        return handoffLane(view, bearing, sweepClear, true);
    }

    boolean handoffSurface(AgentDryCaveRoute.ProbeView view, Direction bearing,
                           BiPredicate<BlockPos, Direction> sweepClear) {
        return handoffLane(view, bearing, sweepClear, false);
    }

    private boolean handoffLane(AgentDryCaveRoute.ProbeView view, Direction bearing,
                                BiPredicate<BlockPos, Direction> sweepClear, boolean woodland) {
        if (!active()) return false;
        for (int i = 0; i < 3; i++) {
            Direction lane = i == 0 ? bearing : i == 1 ? bearing.rotateYClockwise() : bearing.rotateYCounterclockwise();
            BlockPos to = foot.offset(lane), support = to.down();
            Vec3d center = Vec3d.ofBottomCenter(to);
            // This is only a local, in-frame handoff cue. The next owner has
            // to witness and authorize all of its own inputs independently.
            Vec3d farTop = center.add(0.38 * lane.getOffsetX(), -0.03, 0.38 * lane.getOffsetZ());
            if (view.top(farTop, support) != AgentBody.DryRouteTop.WITNESSED) continue;
            if (woodland) {
                var shown = view.state(support);
                if (!(shown.isOf(Blocks.GRASS_BLOCK) || shown.isOf(Blocks.PODZOL) || shown.isOf(Blocks.MYCELIUM))) continue;
            }
            if (view.space(center.add(0, 0.82, 0)) != AgentBody.DryRouteSample.CLEAR
                    || !sweepClear.test(to, lane)) continue;
            finish();
            return true;
        }
        return false;
    }
}
