package io.gameharness.survival;

import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.FallingBlock;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/** One optically witnessed roof cut and one fresh proof of an unstarted shallow quarry tread. */
final class AgentSurfaceHeadroom {
    static final int LOOK_TICKS = 24;

    final AgentSurfaceTread.Edge edge;
    private final long refusedFrame, untilTick;
    private BlockHitResult target;
    private BlockState material;
    private long brokenFrame = -1;
    private boolean equipStarted, cutStarted, retried;

    private AgentSurfaceHeadroom(AgentSurfaceTread.Edge edge, long frame, long tick) {
        this.edge = edge;
        refusedFrame = frame;
        untilTick = tick + LOOK_TICKS;
    }

    static AgentSurfaceHeadroom begin(Set<BlockPos> spent, AgentSurfaceTread.Edge edge,
                                     AgentSurfaceTread.ReturnClearance refusal, boolean unstartedOnUpper,
                                     AgentWorkOrder.Budget budget, long frame, long tick) {
        if (refusal != AgentSurfaceTread.ReturnClearance.OVERHEAD || !unstartedOnUpper
                || !earlyStockGrant(budget) || !budget.canCutCover() || !edge.down().getAxis().isHorizontal()
                || !AgentSurfaceTread.nextFoot(edge.upper(), edge.down()).equals(edge.lower())
                || !spent.add(edge.upper())) return null;
        return new AgentSurfaceHeadroom(edge, frame, tick);
    }

    boolean canLook(long frame, long tick) { return frame > refusedFrame && tick < untilTick; }
    BlockHitResult target() { return target; }
    BlockState material() { return material; }
    boolean broken() { return brokenFrame >= 0; }

    /** Two ray endpoints are derived from the witnessed tread, not from hidden collision results. */
    Vec3d crownRay(boolean near) {
        var column = near ? edge.upper() : edge.lower();
        double offset = near ? 0.31 : -0.31;
        return new Vec3d(column.getX() + 0.5 + offset * edge.down().getOffsetX(), edge.upper().getY() + 2.045,
            column.getZ() + 0.5 + offset * edge.down().getOffsetZ());
    }

    boolean crownHit(BlockHitResult hit, double width) {
        if (hit == null || hit.getType() != HitResult.Type.BLOCK || hit.isInsideBlock()) return false;
        var cell = hit.getBlockPos();
        return cell.getY() == edge.upper().getY() + 2
            && (cell.getX() == edge.upper().getX() && cell.getZ() == edge.upper().getZ()
                || cell.getX() == edge.lower().getX() && cell.getZ() == edge.lower().getZ())
            && AgentSurfaceTread.reverseJumpSweep(edge.upper(), edge.lower(), edge.down(), width).intersects(new Box(cell));
    }

    /** The other column must not already block the same jump. No material is read there. */
    Box otherCrown(BlockPos cell, double width) {
        Box sweep = AgentSurfaceTread.reverseJumpSweep(edge.upper(), edge.lower(), edge.down(), width);
        Direction down = edge.down();
        int x = edge.upper().getX() + (down == Direction.EAST ? 1 : 0);
        int z = edge.upper().getZ() + (down == Direction.SOUTH ? 1 : 0);
        if (down.getAxis() == Direction.Axis.X)
            return cell.getX() < x ? new Box(x, sweep.minY, sweep.minZ, sweep.maxX, sweep.maxY, sweep.maxZ)
                : new Box(sweep.minX, sweep.minY, sweep.minZ, x, sweep.maxY, sweep.maxZ);
        return cell.getZ() < z ? new Box(sweep.minX, sweep.minY, z, sweep.maxX, sweep.maxY, sweep.maxZ)
            : new Box(sweep.minX, sweep.minY, sweep.minZ, sweep.maxX, sweep.maxY, z);
    }

    boolean witness(BlockHitResult hit, BlockState state, double width, AgentWorkOrder.Budget budget, boolean safe) {
        if (target != null || !safe || !crownHit(hit, width) || !licensed(budget, state)) return false;
        target = hit;
        material = state;
        return true;
    }

    static boolean licensed(AgentWorkOrder.Budget budget, BlockState state) {
        return earlyStockGrant(budget) && budget.canCutCover() && budget.policy.prospectCoverAllowed(state)
            && !(state.getBlock() instanceof FallingBlock) && !AgentBody.dryCaveDanger(state);
    }

    private static boolean earlyStockGrant(AgentWorkOrder.Budget budget) {
        return !budget.policy.preset() && !budget.policy.diamondProspecting()
            && AgentWorkOrder.earlySurfaceStock(budget.policy.target().item());
    }

    boolean matches(BlockHitResult hit, BlockState state) {
        return target != null && hit != null && hit.getType() == HitResult.Type.BLOCK && !hit.isInsideBlock()
            && material == state && target.getBlockPos().equals(hit.getBlockPos()) && target.getSide() == hit.getSide();
    }

    boolean beginEquip() {
        if (target == null || equipStarted || cutStarted) return false;
        return equipStarted = true;
    }

    boolean beginCut() {
        if (target == null || cutStarted) return false;
        return cutStarted = true;
    }

    boolean confirmBreak(BlockPos cell, BlockState state, long frame) {
        if (!cutStarted || broken() || !target.getBlockPos().equals(cell) || material != state) return false;
        brokenFrame = frame;
        return true;
    }

    AgentSurfaceTread retry(long frame, long tick, BlockState roof, BlockState upper, BlockState lower, boolean clear) {
        if (!broken() || retried || frame <= brokenFrame || !clear || !roof.isAir()
                || upper != edge.upperSupport() || lower != edge.lowerSupport()) return null;
        retried = true;
        return new AgentSurfaceTread(edge, false, tick);
    }
}
