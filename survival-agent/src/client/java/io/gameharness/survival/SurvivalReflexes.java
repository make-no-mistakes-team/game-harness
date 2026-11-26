package io.gameharness.survival;

import java.util.List;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.CreeperEntity;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

/**
 * 20 TPS autonomous survival reflexes with clean foreground preemption:
 *  1. Lava / fire escape
 *  2. Drowning / breath escape
 *  3. Water-bucket MLG fall clutch (and reclaim)
 *  4. Hostile mob combat & sprint-retreat using combat-flow geometry
 *  5. Auto-eating carried food when injured or hungry
 */
final class SurvivalReflexes {
    private final MinecraftClient client;
    private final Motor motor;
    private final Perception perception;
    private final GuiHands gui;

    private String activeStatus;
    private boolean eating;
    private int eatingTicks;
    private BlockPos placedClutchWater;
    private int clutchReclaimTicks;
    private int hurtLookTicks;
    private float hurtLookYaw;

    SurvivalReflexes(MinecraftClient client, Motor motor, Perception perception, GuiHands gui) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
        this.gui = gui;
    }

    String activeStatus() { return activeStatus; }

    /**
     * Evaluates urgent survival reflexes.
     * Returns true if a reflex claimed the body this tick (preempting ordinary foreground work).
     */
    boolean tick(int currentTick) {
        activeStatus = null;
        var player = client.player;
        var world = client.world;
        if (player == null || world == null || !player.isAlive()) return false;

        // 0. If we just landed a water-bucket clutch, scoop the water back up!
        if (placedClutchWater != null) {
            clutchReclaimTicks++;
            if (clutchReclaimTicks > 35 || !world.getBlockState(placedClutchWater).getFluidState().isIn(FluidTags.WATER)) {
                placedClutchWater = null;
            } else {
                int bucketSlot = motor.findHotbarItem(Items.BUCKET);
                if (bucketSlot >= 0) {
                    player.getInventory().selectedSlot = bucketSlot;
                    motor.lookAtPoint(Vec3d.ofCenter(placedClutchWater), Motor.LookMode.COMBAT);
                    if (motor.currentAimErrorDeg() < 18.0 && client.interactionManager != null) {
                        client.interactionManager.interactItem(player, Hand.MAIN_HAND);
                        player.swingHand(Hand.MAIN_HAND);
                    }
                    activeStatus = "reclaiming clutch water";
                    return true;
                }
                placedClutchWater = null;
            }
        }

        // 1. Lava / fire emergency!
        if (player.isInLava() || (player.isOnFire() && perception.isNearKnownLava(
                player.getBlockX(), player.getBlockY(), player.getBlockZ()))) {
            closeScreenIfOpen();
            handleLavaEscape(player, world);
            activeStatus = "escaping lava";
            return true;
        }

        // 2. Water-bucket MLG fall clutch!
        if (!player.isOnGround() && !player.isTouchingWater()
                && player.getVelocity().y < -0.56 && player.fallDistance > 3.5f) {
            int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
            if (waterSlot >= 0) {
                closeScreenIfOpen();
                if (tryWaterClutch(player, world, waterSlot)) {
                    activeStatus = "water-bucket fall clutch";
                    return true;
                }
            }
        }

        // 3. Drowning / underwater breath emergency!
        if (player.isSubmergedInWater() && player.getAir() < 160) {
            closeScreenIfOpen();
            handleDrownEscape(player, world);
            activeStatus = "surfacing for air";
            return true;
        }

        // 4. Hostile mob combat or retreat (using combat-flow geometry!)
        List<LivingEntity> hostiles = perception.visibleHostiles();
        LivingEntity nearestThreat = hostiles.isEmpty() ? null : hostiles.get(0);
        if (nearestThreat != null && nearestThreat.distanceTo(player) <= 10.5f) {
            closeScreenIfOpen();
            handleHostile(player, world, hostiles, nearestThreat);
            return true;
        }

        // 4b. Recently hurt by an unseen attacker — whip camera around to locate threat!
        if (currentTick - perception.lastHurtTick() <= 14 && nearestThreat == null
                && !player.isInLava() && !player.isSubmergedInWater() && player.fallDistance < 2.0f) {
            closeScreenIfOpen();
            if (hurtLookTicks <= 0) {
                hurtLookYaw = player.getYaw() + 145f;
                hurtLookTicks = 12;
            }
            hurtLookTicks--;
            motor.lookAtAngles(hurtLookYaw, 4f, Motor.LookMode.COMBAT);
            activeStatus = "checking behind after hit";
            return true;
        } else {
            hurtLookTicks = 0;
        }

        // 5. Auto-eat carried food when hurt or hungry (never while a hostile is swinging on us)
        boolean emergencyFood = player.getHealth() < 8.5f || player.getHungerManager().getFoodLevel() <= 6;
        boolean needFood = (player.getHealth() < 15.0f && player.getHungerManager().getFoodLevel() < 20)
            || player.getHungerManager().getFoodLevel() <= 12;

        if (eating) {
            eatingTicks++;
            int slot = motor.findHotbarFood(emergencyFood);
            if (slot < 0 || !needFood || eatingTicks > 48) {
                eating = false;
                eatingTicks = 0;
            } else {
                player.getInventory().selectedSlot = slot;
                motor.requestHoldUse();
                activeStatus = "eating food to recover";
                return true;
            }
        } else if (needFood && client.currentScreen == null) {
            int foodSlot = motor.findHotbarFood(emergencyFood);
            if (foodSlot >= 0) {
                player.getInventory().selectedSlot = foodSlot;
                motor.requestHoldUse();
                eating = true;
                eatingTicks = 1;
                activeStatus = "eating food";
                return true;
            }
        }

        return false;
    }

    private void closeScreenIfOpen() {
        if (client.currentScreen != null) {
            gui.abort();
        }
    }

    private void handleLavaEscape(ClientPlayerEntity player, ClientWorld world) {
        // Pour water bucket immediately if carried!
        int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
        if (waterSlot >= 0) {
            player.getInventory().selectedSlot = waterSlot;
            motor.lookAtAngles(player.getYaw(), 82f, Motor.LookMode.COMBAT);
            if (player.getPitch() > 65f && client.interactionManager != null) {
                client.interactionManager.interactItem(player, Hand.MAIN_HAND);
                player.swingHand(Hand.MAIN_HAND);
            }
        }
        // Move toward nearest dry solid block around us
        Vec3d bestExit = findSafeEscapeDirection(player, world, player.getPos(), true);
        motor.moveToward(bestExit, true, true, false, false);
    }

    private boolean tryWaterClutch(ClientPlayerEntity player, ClientWorld world, int waterSlot) {
        // Find distance to solid ground beneath us
        BlockPos feet = player.getBlockPos();
        BlockPos landing = null;
        for (int dy = 1; dy <= 10; dy++) {
            BlockPos probe = feet.down(dy);
            BlockState st = world.getBlockState(probe);
            if (st.getFluidState().isIn(FluidTags.WATER)) return false; // already landing in water
            if (Perception.isSolidSupport(st)) {
                landing = probe;
                break;
            }
        }
        if (landing == null) return false;
        player.getInventory().selectedSlot = waterSlot;
        Vec3d aim = Vec3d.ofCenter(landing).add(0, 0.5, 0);
        motor.lookAtPoint(aim, Motor.LookMode.COMBAT);

        double distToGround = player.getY() - (landing.getY() + 1.0);
        if (distToGround <= 4.3 && player.getPitch() > 68f) {
            HitResult ch = client.crosshairTarget;
            if (ch instanceof BlockHitResult bhr && bhr.getType() == HitResult.Type.BLOCK && client.interactionManager != null) {
                var res = client.interactionManager.interactItem(player, Hand.MAIN_HAND);
                if (res.isAccepted()) {
                    player.swingHand(Hand.MAIN_HAND);
                    placedClutchWater = bhr.getBlockPos().offset(bhr.getSide());
                    clutchReclaimTicks = 0;
                }
            }
        }
        return true;
    }

    private void handleDrownEscape(ClientPlayerEntity player, ClientWorld world) {
        motor.requestJump();
        Vec3d bank = findSafeEscapeDirection(player, world, player.getPos(), false);
        motor.moveToward(bank, false, true, false, true);
    }

    private void handleHostile(ClientPlayerEntity player, ClientWorld world, List<LivingEntity> hostiles, LivingEntity target) {
        double dist = target.distanceTo(player);
        boolean isCreeper = target instanceof CreeperEntity;
        int closeCount = 0;
        for (LivingEntity m : hostiles) {
            if (m.distanceTo(player) <= 7.5f) closeCount++;
        }

        // Creeper fuse retreat or low-HP/outnumbered tactical retreat using combat-flow geometry!
        boolean shouldFlee = (isCreeper && dist < 5.8)
            || player.getHealth() <= 7.5f
            || (closeCount >= 3 && player.getHealth() < 14.0f);

        if (shouldFlee) {
            Vec3d escapePos = findSafeCombatRetreat(player, target.getPos());
            motor.moveToward(escapePos, true, shouldJumpToward(player, escapePos), false, true);
            activeStatus = isCreeper ? "evading creeper" : "retreating from hostile";
            return;
        }

        // Engage in melee combat with smooth human aiming, weapon cooldown timing, and combat-flow strafing!
        motor.selectBestWeapon();
        motor.attackEntity(target);

        double dx = target.getX() - player.getX();
        double dz = target.getZ() - player.getZ();
        double horiz = Math.hypot(dx, dz);

        if (horiz > 2.75) {
            // Approach smoothly without stepping off a combat-flow cliff
            Vec3d approach = target.getPos();
            if (isSafeCombatStep(player, dx / Math.max(1e-4, horiz), dz / Math.max(1e-4, horiz))) {
                motor.moveRelativeToYaw(dx, dz, horiz > 4.2, player.horizontalCollision);
            }
        } else if (horiz < 1.85 || player.getAttackCooldownProgress(0.5f) < 0.72f) {
            // Backpedal / strafe slightly between swings using combat-flow clearance so we don't fall off a ledge!
            double bx = -dx / Math.max(1e-4, horiz);
            double bz = -dz / Math.max(1e-4, horiz);
            if (isSafeCombatStep(player, bx, bz)) {
                motor.moveRelativeToYaw(bx, bz, false, false);
            } else if (isSafeCombatStep(player, -bz, bx)) {
                motor.moveRelativeToYaw(-bz, bx, false, false);
            } else if (isSafeCombatStep(player, bz, -bx)) {
                motor.moveRelativeToYaw(bz, -bx, false, false);
            }
        }
        activeStatus = "fighting " + target.getType().getName().getString();
    }

    /** Pick the best 360-degree retreat direction away from `threatPos` using combat-flow geometry (no cliffs/walls/lava!). */
    private Vec3d findSafeCombatRetreat(ClientPlayerEntity player, Vec3d threatPos) {
        double awayX = player.getX() - threatPos.x;
        double awayZ = player.getZ() - threatPos.z;
        double awayAngle = Math.atan2(awayZ, awayX);

        double bestScore = Double.NEGATIVE_INFINITY;
        double bestDirX = Math.cos(awayAngle);
        double bestDirZ = Math.sin(awayAngle);

        for (int i = 0; i < 12; i++) {
            double ang = awayAngle + (i * Math.PI * 2.0 / 12.0);
            double dx = Math.cos(ang);
            double dz = Math.sin(ang);
            double score = Math.cos(ang - awayAngle) * 4.0;

            // Check combat-flow geometry 1..3 blocks ahead along this bearing
            int clearSteps = 0;
            for (int step = 1; step <= 3; step++) {
                int bx = (int) Math.floor(player.getX() + dx * step);
                int by = player.getBlockY();
                int bz = (int) Math.floor(player.getZ() + dz * step);
                BlockState feet = perception.getObserved(bx, by, bz);
                BlockState head = perception.getObserved(bx, by + 1, bz);
                BlockState below = perception.getObserved(bx, by - 1, bz);
                BlockState below2 = perception.getObserved(bx, by - 2, bz);

                if (Perception.isHazardBlock(feet) || Perception.isHazardBlock(below)) {
                    score -= 100.0;
                    break;
                }
                if (feet != null && !Perception.isPassable(feet)) {
                    // Check 1-block step-up
                    BlockState upHead = perception.getObserved(bx, by + 2, bz);
                    if (Perception.isSolidSupport(feet) && Perception.isPassable(head) && Perception.isPassable(upHead)) {
                        score -= 1.0;
                        clearSteps++;
                    } else {
                        score -= 15.0;
                        break;
                    }
                } else if (below != null && !Perception.isSolidSupport(below)
                        && (below2 == null || !Perception.isSolidSupport(below2))) {
                    // Drop-off! Avoid backing off a cliff!
                    score -= 40.0;
                    break;
                } else {
                    clearSteps++;
                }
            }
            score += clearSteps * 3.0;
            if (score > bestScore) {
                bestScore = score;
                bestDirX = dx;
                bestDirZ = dz;
            }
        }
        return player.getPos().add(bestDirX * 5.0, 0, bestDirZ * 5.0);
    }

    private boolean isSafeCombatStep(ClientPlayerEntity player, double dirX, double dirZ) {
        int bx = (int) Math.floor(player.getX() + dirX * 1.15);
        int by = player.getBlockY();
        int bz = (int) Math.floor(player.getZ() + dirZ * 1.15);
        BlockState feet = perception.getObserved(bx, by, bz);
        BlockState head = perception.getObserved(bx, by + 1, bz);
        BlockState below = perception.getObserved(bx, by - 1, bz);
        BlockState below2 = perception.getObserved(bx, by - 2, bz);
        if (Perception.isHazardBlock(feet) || Perception.isHazardBlock(below)) return false;
        if (feet != null && !Perception.isPassable(feet)) return false;
        if (head != null && !Perception.isPassable(head)) return false;
        return Perception.isSolidSupport(below) || Perception.isSolidSupport(below2);
    }

    private boolean shouldJumpToward(ClientPlayerEntity player, Vec3d dest) {
        if (player.horizontalCollision) return true;
        double dx = dest.x - player.getX();
        double dz = dest.z - player.getZ();
        double len = Math.hypot(dx, dz);
        if (len < 0.1) return false;
        int bx = (int) Math.floor(player.getX() + (dx / len) * 0.9);
        int bz = (int) Math.floor(player.getZ() + (dz / len) * 0.9);
        BlockState ahead = perception.getObserved(bx, player.getBlockY(), bz);
        return ahead != null && Perception.isSolidSupport(ahead);
    }

    private Vec3d findSafeEscapeDirection(ClientPlayerEntity player, ClientWorld world, Vec3d origin, boolean avoidLava) {
        BlockPos p = player.getBlockPos();
        BlockPos best = null;
        double bestDist = Double.POSITIVE_INFINITY;
        for (int dx = -4; dx <= 4; dx++) {
            for (int dz = -4; dz <= 4; dz++) {
                for (int dy = 0; dy <= 2; dy++) {
                    BlockPos cand = p.add(dx, dy, dz);
                    BlockState f = world.getBlockState(cand);
                    BlockState h = world.getBlockState(cand.up());
                    BlockState b = world.getBlockState(cand.down());
                    if (f.isAir() && h.isAir() && Perception.isSolidSupport(b)) {
                        if (avoidLava && perception.isNearKnownLava(cand.getX(), cand.getY(), cand.getZ())) continue;
                        double d = cand.getSquaredDistance(p);
                        if (d < bestDist) {
                            bestDist = d;
                            best = cand;
                        }
                    }
                }
            }
        }
        return best != null ? Vec3d.ofBottomCenter(best) : origin.add(3.0, 1.0, 0.0);
    }
}
