package io.gameharness.survival;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.LeavesBlock;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** Owns the ordinary-work exclusion and the exact physical premises of refused exits. */
final class AgentSupplyEgress {
    private record Refusal(String detail, Set<BlockPos> cells) {}

    private final Map<BlockPos, Refusal> refusals = new HashMap<>();
    private final Set<BlockPos> checked = new HashSet<>();
    private BlockPos foot;
    private boolean airborneHold;

    BlockPos foot() { return foot; }
    boolean active() { return foot != null; }

    boolean holdOrdinary(boolean airborne) {
        if (!airborne) airborneHold = false;
        return airborneHold;
    }

    String refusal(BlockPos standing) {
        var refusal = refusals.get(standing);
        return refusal == null ? null : refusal.detail();
    }

    boolean begin(BlockPos standing, boolean grounded) {
        if (!grounded || active() || refusal(standing) != null) return false;
        landed(standing);
        return true;
    }

    void landed(BlockPos standing) {
        foot = standing;
        checked.clear();
        checked.add(standing.down());
    }

    void considered(BlockPos cell) { checked.add(cell); }

    void observeBreak(BlockPos cell) {
        if (!refusals.isEmpty()) refusals.values().removeIf(refusal -> refusal.cells().contains(cell));
    }

    String refuse(String why, boolean airborne) {
        String reason = "supply egress blocked at " + foot.toShortString() + ": " + why;
        refusals.put(foot, new Refusal(reason, Set.copyOf(checked)));
        finish();
        airborneHold = airborne;
        return reason;
    }

    void finish() {
        foot = null;
        airborneHold = false;
        checked.clear();
    }

    void reset() {
        finish();
        refusals.clear();
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
        if (!active()) return false;
        for (int i = 0; i < 3; i++) {
            Direction lane = i == 0 ? bearing : i == 1 ? bearing.rotateYClockwise() : bearing.rotateYCounterclockwise();
            BlockPos to = foot.offset(lane), support = to.down();
            Vec3d center = Vec3d.ofBottomCenter(to);
            // This is only a local, in-frame handoff cue. The next owner has
            // to witness and authorize all of its own inputs independently.
            Vec3d farTop = center.add(0.38 * lane.getOffsetX(), -0.03, 0.38 * lane.getOffsetZ());
            if (view.top(farTop, support) != AgentBody.DryRouteTop.WITNESSED) continue;
            var shown = view.state(support);
            if (!(shown.isOf(Blocks.GRASS_BLOCK) || shown.isOf(Blocks.PODZOL) || shown.isOf(Blocks.MYCELIUM))
                    || view.space(center.add(0, 0.82, 0)) != AgentBody.DryRouteSample.CLEAR
                    || !sweepClear.test(to, lane)) continue;
            finish();
            return true;
        }
        return false;
    }
}
