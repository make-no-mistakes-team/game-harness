package io.gameharness.survival;

import java.util.List;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.LightType;

/**
 * Continuous, human-like 3D route executor over Pathfinder.Plan.
 * Uses multi-step lookahead so the player walks/sprints smoothly at arbitrary bearings
 * without stopping at every grid cell, while validating terrain hypotheses as blocks open.
 */
final class RouteExecutor {
    enum Status { RUNNING, COMPLETE, INVALIDATED, STUCK }

    private final MinecraftClient client;
    private final Motor motor;
    private final Perception perception;

    private Pathfinder.Plan plan;
    private int stepIndex;
    private int ticksOnStep;
    private int totalStuckTicks;
    private Vec3d lastProgressPos;
    private int lastTorchTick = -200;

    RouteExecutor(MinecraftClient client, Motor motor, Perception perception) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
    }

    void setPlan(Pathfinder.Plan newPlan) {
        this.plan = newPlan;
        this.stepIndex = 0;
        this.ticksOnStep = 0;
        this.totalStuckTicks = 0;
        this.lastProgressPos = client.player == null ? null : client.player.getPos();
    }

    void clear() {
        this.plan = null;
        this.stepIndex = 0;
        this.ticksOnStep = 0;
        this.totalStuckTicks = 0;
    }

    boolean hasPlan() {
        return plan != null && !plan.isEmpty() && stepIndex < plan.steps().size();
    }

    Pathfinder.Plan currentPlan() { return plan; }

    Status tick(int currentTick, boolean allowTorches) {
        var player = client.player;
        var world = client.world;
        if (player == null || world == null || plan == null || stepIndex >= plan.steps().size()) {
            return Status.COMPLETE;
        }

        // Track physical progress so we never hang on an unexpected obstacle
        Vec3d pos = player.getPos();
        if (lastProgressPos == null || pos.squaredDistanceTo(lastProgressPos) > 0.08 || motor.isMining()) {
            lastProgressPos = pos;
            totalStuckTicks = 0;
        } else {
            totalStuckTicks++;
            if (totalStuckTicks > 48) {
                clear();
                return Status.STUCK;
            }
        }

        // Advance stepIndex if we already arrived at step.to (or skipped ahead naturally while sprinting!)
        advanceArrivedSteps(player);
        if (stepIndex >= plan.steps().size()) {
            return Status.COMPLETE;
        }

        // Opportunistic torch placement in dark underground tunnels
        if (allowTorches && currentTick - lastTorchTick >= 40 && player.isOnGround()) {
            BlockPos feet = player.getBlockPos();
            if (world.getLightLevel(LightType.SKY, feet) == 0
                    && world.getLightLevel(LightType.BLOCK, feet) <= 2
                    && world.getBlockState(feet).isAir()
                    && Perception.isSolidSupport(world.getBlockState(feet.down()))) {
                int torchSlot = motor.findHotbarItem(Items.TORCH);
                if (torchSlot >= 0) {
                    if (motor.placeBlockAt(feet, torchSlot)) {
                        lastTorchTick = currentTick;
                    }
                    return Status.RUNNING;
                }
            }
        }

        Pathfinder.Step step = plan.steps().get(stepIndex);
        ticksOnStep++;
        int stepTimeout = step.toBreak().isEmpty() ? 140 : 210;
        if (ticksOnStep > stepTimeout) {
            clear();
            return Status.STUCK;
        }

        // 1. Validate live safety of the upcoming step (catches disproved underground hypotheses immediately!)
        if (!validateStepSafety(world, step)) {
            clear();
            return Status.INVALIDATED;
        }

        // 2. Break any obstructing blocks in step.toBreak (in order!)
        for (BlockPos bp : step.toBreak()) {
            BlockState st = world.getBlockState(bp);
            if (!Perception.isPassable(st) && st.getFluidState().isEmpty()) {
                // Safety recheck: never break into newly visible lava or water!
                if (perception.isNearKnownLava(bp.getX(), bp.getY(), bp.getZ())
                        || perception.isNearKnownFluidAboveOrSide(bp.getX(), bp.getY(), bp.getZ())) {
                    clear();
                    return Status.INVALIDATED;
                }
                // If out of reach, nudge closer to step.from
                if (player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(bp)) > Motor.REACH_SQ) {
                    motor.moveToward(Vec3d.ofBottomCenter(step.from()), false, false, false, false);
                }
                motor.mineBlock(bp, true, true);
                return Status.RUNNING;
            }
        }

        // 3. Place any required scaffold blocks (PILLAR / BRIDGE)
        if (!step.toPlace().isEmpty()) {
            int scaffoldSlot = motor.findHotbarScaffold();
            if (scaffoldSlot < 0) {
                clear();
                return Status.INVALIDATED;
            }
            for (BlockPos placePos : step.toPlace()) {
                BlockState st = world.getBlockState(placePos);
                if (st.isAir() || st.isReplaceable()) {
                    if (step.kind() == Pathfinder.MoveKind.PILLAR) {
                        // Center over block, jump, look down and place underfoot
                        Vec3d center = Vec3d.ofBottomCenter(step.from());
                        if (Math.hypot(player.getX() - center.x, player.getZ() - center.z) > 0.25) {
                            motor.moveToward(center, false, false, true, false);
                        } else {
                            motor.requestJump();
                            motor.lookAtPoint(Vec3d.ofBottomCenter(placePos).add(0, -0.05, 0), Motor.LookMode.FINE);
                            if (player.getY() >= placePos.getY() + 0.85) {
                                motor.placeBlockAt(placePos, scaffoldSlot);
                            }
                        }
                    } else {
                        // BRIDGE: sneak toward edge and place scaffold into gap
                        Vec3d edge = Vec3d.ofBottomCenter(step.from())
                            .lerp(Vec3d.ofBottomCenter(step.to()), 0.42);
                        if (!motor.placeBlockAt(placePos, scaffoldSlot)) {
                            motor.moveToward(edge, false, false, true, false);
                        }
                    }
                    return Status.RUNNING;
                }
            }
        }

        // 4. For STAIR_DOWN / DIG_WALK: verify observed floor beneath destination before stepping in!
        if (step.kind() == Pathfinder.MoveKind.STAIR_DOWN || step.kind() == Pathfinder.MoveKind.DIG_WALK) {
            BlockPos floorPos = step.to().down();
            BlockState floorState = world.getBlockState(floorPos);
            if (!Perception.isSolidSupport(floorState)) {
                // Hypothesis disproved (opened into a cave/void/lava)! Replan immediately!
                perception.recordObserved(floorPos, floorState, false);
                clear();
                return Status.INVALIDATED;
            }
        }

        // 5. Continuous human-like locomotion with multi-step lookahead!
        Vec3d steerTarget = computeLookaheadTarget(stepIndex);
        // If brushing low leaves overhead while stepping up onto raised terrain, clear the leaf block cleanly!
        if (step.kind() == Pathfinder.MoveKind.STEP_UP && player.horizontalCollision) {
            BlockPos headLeaf = step.to().up();
            BlockPos aboveSelf = player.getBlockPos().up(2);
            if (world.getBlockState(headLeaf).getBlock() instanceof net.minecraft.block.LeavesBlock) {
                motor.mineBlock(headLeaf, true, false);
                return Status.RUNNING;
            }
            if (world.getBlockState(aboveSelf).getBlock() instanceof net.minecraft.block.LeavesBlock) {
                motor.mineBlock(aboveSelf, true, false);
                return Status.RUNNING;
            }
        }
        boolean needJump = shouldJump(player, world, step);
        boolean canSprint = canSprintSegment(player, stepIndex);
        boolean sneak = step.kind() == Pathfinder.MoveKind.BRIDGE;

        motor.moveToward(steerTarget, canSprint, needJump, sneak, true);
        return Status.RUNNING;
    }

    private void advanceArrivedSteps(ClientPlayerEntity player) {
        List<Pathfinder.Step> steps = plan.steps();
        // Check if we're already at a slightly later step along a pure walking segment
        int lookMax = Math.min(steps.size() - 1, stepIndex + 2);
        for (int i = lookMax; i >= stepIndex; i--) {
            Pathfinder.Step s = steps.get(i);
            if (i > stepIndex && (!s.toBreak().isEmpty() || !s.toPlace().isEmpty())) continue;
            if (reached(player, s.to(), s.kind())) {
                stepIndex = i + 1;
                ticksOnStep = 0;
                return;
            }
        }
    }

    private static boolean reached(ClientPlayerEntity player, BlockPos dest, Pathfinder.MoveKind kind) {
        double dx = player.getX() - (dest.getX() + 0.5);
        double dz = player.getZ() - (dest.getZ() + 0.5);
        double dy = player.getY() - dest.getY();
        double horizTol = (kind == Pathfinder.MoveKind.WALK || kind == Pathfinder.MoveKind.DIAGONAL) ? 0.58 : 0.44;
        return (dx * dx + dz * dz) <= horizTol * horizTol && Math.abs(dy) <= 0.65;
    }

    private Vec3d computeLookaheadTarget(int idx) {
        List<Pathfinder.Step> steps = plan.steps();
        Pathfinder.Step first = steps.get(idx);
        if (!first.toBreak().isEmpty() || !first.toPlace().isEmpty()
                || first.kind() == Pathfinder.MoveKind.PILLAR
                || first.kind() == Pathfinder.MoveKind.BRIDGE) {
            return Vec3d.ofBottomCenter(first.to());
        }
        // Look ahead up to 3 pure movement steps if they remain nearly collinear & same elevation!
        BlockPos best = first.to();
        int baseDx = first.to().getX() - first.from().getX();
        int baseDz = first.to().getZ() - first.from().getZ();
        for (int i = idx + 1; i < Math.min(steps.size(), idx + 4); i++) {
            Pathfinder.Step next = steps.get(i);
            if (!next.toBreak().isEmpty() || !next.toPlace().isEmpty()) break;
            if (next.kind() != Pathfinder.MoveKind.WALK && next.kind() != Pathfinder.MoveKind.DIAGONAL) break;
            if (next.to().getY() != first.to().getY()) break;
            int ndx = next.to().getX() - next.from().getX();
            int ndz = next.to().getZ() - next.from().getZ();
            // Keep smooth curve: dot product >= 0 (no sharp reversal)
            if (baseDx * ndx + baseDz * ndz <= 0) break;
            best = next.to();
        }
        return Vec3d.ofBottomCenter(best);
    }

    private boolean shouldJump(ClientPlayerEntity player, ClientWorld world, Pathfinder.Step step) {
        if (player.isTouchingWater()) {
            return step.kind() == Pathfinder.MoveKind.STEP_UP
                || !player.isOnGround()
                || player.getY() < step.to().getY() + 0.25
                || player.horizontalCollision;
        }
        if (step.kind() == Pathfinder.MoveKind.STEP_UP) {
            double dist = Math.hypot(player.getX() - (step.to().getX() + 0.5), player.getZ() - (step.to().getZ() + 0.5));
            boolean belowLedge = player.getY() < step.to().getY() - 0.08;
            // Jump crisply right as we reach the ledge edge (0.30..1.15m) or on contact — never prematurely!
            return belowLedge && ((dist < 1.15 && dist > 0.30) || player.horizontalCollision);
        }
        // Proactive seamless jump when the NEXT step is a STEP_UP and we're closing in smoothly
        if (plan != null && stepIndex + 1 < plan.steps().size()) {
            Pathfinder.Step next = plan.steps().get(stepIndex + 1);
            if (next.kind() == Pathfinder.MoveKind.STEP_UP && next.toBreak().isEmpty()) {
                double nextDist = Math.hypot(player.getX() - (next.to().getX() + 0.5), player.getZ() - (next.to().getZ() + 0.5));
                if (player.getY() < next.to().getY() - 0.08 && nextDist < 1.10 && player.isOnGround()) {
                    return true;
                }
            }
        }
        if (player.horizontalCollision && player.isOnGround() && step.toBreak().isEmpty()) {
            // Only jump on collision if there's headroom above us so we don't head-bonk a low ceiling
            return Perception.isPassable(world.getBlockState(player.getBlockPos().up(2)));
        }
        return false;
    }

    private boolean canSprintSegment(ClientPlayerEntity player, int idx) {
        if (player.getHungerManager().getFoodLevel() <= 6 || player.isTouchingWater()) return false;
        Pathfinder.Step step = plan.steps().get(idx);
        if (step.kind() == Pathfinder.MoveKind.BRIDGE || step.kind() == Pathfinder.MoveKind.PILLAR
                || step.kind() == Pathfinder.MoveKind.STAIR_DOWN || step.kind() == Pathfinder.MoveKind.DIG_DOWN) {
            return false;
        }
        // Sprint smoothly on open flat/diagonal/step-up paths!
        return step.toBreak().isEmpty() && step.toPlace().isEmpty();
    }

    private boolean validateStepSafety(ClientWorld world, Pathfinder.Step step) {
        BlockPos to = step.to();
        BlockState dstFeet = world.getBlockState(to);
        BlockState dstHead = world.getBlockState(to.up());
        BlockState dstBelow = world.getBlockState(to.down());
        if (Perception.isHazardBlock(dstFeet) || Perception.isHazardBlock(dstHead) || Perception.isHazardBlock(dstBelow)) {
            return false;
        }
        // Check if a walking step suddenly became obstructed by a new block (e.g., falling gravel!)
        if (step.toBreak().isEmpty() && !Perception.isPassable(dstFeet)) {
            return false;
        }
        if (step.toBreak().isEmpty() && !Perception.isPassable(dstHead)) {
            return false;
        }
        return true;
    }
}
