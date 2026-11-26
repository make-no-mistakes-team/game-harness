package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

/**
 * 20 TPS autonomous survival reflexes with clean foreground preemption:
 *  1. Lava / fire escape
 *  2. Drowning / breath escape
 *  3. Water-bucket MLG fall clutch (and reclaim)
 *  4. Emergency shelter / burrow-in build, heal-inside, and safe unseal
 *  5. Hostile mob combat, active shield blocking, tactical retreat, and occluded-mob guard
 *  6. Auto-eating carried food when injured or hungry
 */
final class SurvivalReflexes {
    enum ShelterState { NONE, BUILDING, SEALED_HEALING, UNSEALING }

    private static final Direction[] CARDINALS = {
        Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST
    };

    private final MinecraftClient client;
    private final Motor motor;
    private final Perception perception;
    private final GuiHands gui;
    private final SafeDescent descent;

    private String activeStatus;
    private boolean eating;
    private int eatingTicks;
    private int hurtLookTicks;
    private float hurtLookYaw;

    // Combat state & telemetry
    private CombatPlanner.CombatStance combatStance = CombatPlanner.CombatStance.AUTO;
    private CombatPlanner.TacticalAction lastAction = CombatPlanner.TacticalAction.FIGHT;
    private CombatPlanner.EscapeAssessment lastEscape = new CombatPlanner.EscapeAssessment(1, 0, 10.0, 8, false);
    private int creeperRetreatTicks;
    private int fleeStuckTicks;
    private Vec3d fleeLastPos;
    private int strafeFlipTicks;
    private int strafeSign = 1;
    private int shieldAdvanceCycle;
    private int recentBlockTicks;
    private int lastShieldDamage = -1;
    private float lastTrackedHealth = Float.NaN;
    private float damageTaken;
    private int shieldBlocks;
    private int shieldBlockingTicks;

    // Emergency shelter / burrow-in state & telemetry
    private ShelterState shelterState = ShelterState.NONE;
    private CombatPlanner.ShelterMode shelterMode = CombatPlanner.ShelterMode.NONE;
    private BlockPos shelterAnchor;
    private int shelterStartY;
    private int shelterBuildTicks;
    private int shelterBlockedTicks;
    private int shelterSealedTicks;
    private int shelterUnsealTicks;
    private int manualShelterTicks;
    private int shelterBlocksPlaced;
    private boolean shelterEverSealed;
    private boolean shelterEverRoofed;
    private Direction unsealDir = Direction.NORTH;

    SurvivalReflexes(MinecraftClient client, Motor motor, Perception perception, GuiHands gui, SafeDescent descent) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
        this.gui = gui;
        this.descent = descent;
    }

    void resetForLife() {
        activeStatus = null;
        combatStance = CombatPlanner.CombatStance.AUTO;
        eating = false;
        eatingTicks = 0;
        hurtLookTicks = 0;
        creeperRetreatTicks = 0;
        fleeStuckTicks = 0;
        fleeLastPos = null;
        recentBlockTicks = 0;
        lastShieldDamage = -1;
        lastTrackedHealth = Float.NaN;
        shelterState = ShelterState.NONE;
        shelterMode = CombatPlanner.ShelterMode.NONE;
        shelterAnchor = null;
        shelterBuildTicks = 0;
        shelterBlockedTicks = 0;
        shelterSealedTicks = 0;
        shelterUnsealTicks = 0;
        manualShelterTicks = 0;
    }

    String activeStatus() { return activeStatus; }
    CombatPlanner.CombatStance combatStance() { return combatStance; }
    void setCombatStance(CombatPlanner.CombatStance stance) {
        this.combatStance = stance == null ? CombatPlanner.CombatStance.AUTO : stance;
    }
    String activeActionName() { return lastAction.name().toLowerCase(); }
    CombatPlanner.EscapeAssessment lastEscape() { return lastEscape; }
    int shieldBlocks() { return shieldBlocks; }
    int shieldBlockingTicks() { return shieldBlockingTicks; }
    float damageTaken() { return damageTaken; }
    boolean inShelter() { return shelterState != ShelterState.NONE; }
    boolean shelterSealed() {
        var p = client.player;
        var w = client.world;
        return p != null && w != null && isShelterSealed(w, p.getBlockPos());
    }
    boolean shelterRoofed() {
        var p = client.player;
        var w = client.world;
        return p != null && w != null && isShelterRoofed(w, p.getBlockPos());
    }
    boolean shelterEverSealed() { return shelterEverSealed; }
    boolean shelterEverRoofed() { return shelterEverRoofed; }
    int shelterBlocksPlaced() { return shelterBlocksPlaced; }

    /** Requested by TaskRunner's build_shelter task or strategist plan. */
    void requestManualShelter(int holdTicks) {
        manualShelterTicks = Math.max(manualShelterTicks, Math.max(80, holdTicks));
        if (shelterState == ShelterState.NONE || shelterState == ShelterState.UNSEALING) {
            beginShelter(client.player, client.world);
        }
    }

    /**
     * Evaluates urgent survival reflexes.
     * Returns true if a reflex claimed the body this tick (preempting ordinary foreground work).
     */
    boolean tick(int currentTick) {
        activeStatus = null;
        var player = client.player;
        var world = client.world;
        if (player == null || world == null || !player.isAlive()) return false;

        trackVitalsAndShield(player);
        if (creeperRetreatTicks > 0) creeperRetreatTicks--;
        if (recentBlockTicks > 0) recentBlockTicks--;
        if (manualShelterTicks > 0) manualShelterTicks--;
        strafeFlipTicks++;
        if (strafeFlipTicks >= 28) {
            strafeFlipTicks = 0;
            strafeSign = -strafeSign;
        }

        // 0. Lava / fire emergency!
        if (player.isInLava() || (player.isOnFire() && perception.isNearKnownLava(
                player.getBlockX(), player.getBlockY(), player.getBlockZ()))) {
            shelterState = ShelterState.NONE;
            closeScreenIfOpen();
            handleLavaEscape(player, world);
            activeStatus = "escaping lava";
            return true;
        }

        // 1. Reactive water-bucket MLG fall clutch & reclaim (delegated to SafeDescent; skips active intentional descent / boat rides!)
        if (descent != null && descent.tickReactiveFallClutch(player, world, currentTick)) {
            closeScreenIfOpen();
            activeStatus = descent.statusText();
            return true;
        }

        // 2. Drowning / underwater breath emergency!
        if (player.isSubmergedInWater() && player.getAir() < 210) {
            shelterState = ShelterState.NONE;
            closeScreenIfOpen();
            handleDrownEscape(player, world);
            activeStatus = "surfacing for air";
            return true;
        }

        // 3b. Active emergency shelter / burrow-in state machine (or explicit SHELTER stance!)
        if (shelterState != ShelterState.NONE) {
            if (tickShelter(player, world, currentTick)) {
                return true;
            }
        } else if (combatStance == CombatPlanner.CombatStance.SHELTER
                && Motor.countShelterBlocks(player) >= 1) {
            beginShelter(player, world);
            if (shelterState != ShelterState.NONE && tickShelter(player, world, currentTick)) {
                return true;
            }
        }

        // 4. Hostile mob combat, shielding, tactical retreat, or autonomous emergency shelter!
        List<CombatPlanner.ThreatInfo> threats = perception.activeThreats(player);
        boolean incomingArrow = perception.hasIncomingArrow();
        boolean hasNearbyThreat = incomingArrow || hasThreatWithin(threats, 14.5);

        if (hasNearbyThreat) {
            // Equip carried hotbar shield into offhand in 1 tick via vanilla F-key swap!
            if (tryQuickEquipShield(player, threats)) {
                activeStatus = "equipping shield to offhand";
                return true;
            }
            closeScreenIfOpen();
            handleHostileEncounter(player, world, threats, incomingArrow, currentTick);
            return true;
        }

        // 4a. When out of immediate danger, move a hotbar shield cleanly to offhand so we're ready!
        if (client.currentScreen == null && !player.getOffHandStack().isOf(Items.SHIELD)) {
            int hs = motor.findHotbarShield();
            if (hs >= 0) {
                player.getInventory().selectedSlot = hs;
                if (motor.swapHands()) {
                    activeStatus = "equipping shield";
                    return true;
                }
            }
        }

        // 4b. Recently hurt by an unseen attacker — whip camera around to locate threat (raise shield if carried)!
        if (currentTick - perception.lastHurtTick() <= 16 && threats.isEmpty()
                && !player.isInLava() && !player.isSubmergedInWater() && player.fallDistance < 2.0f) {
            closeScreenIfOpen();
            if (hurtLookTicks <= 0) {
                hurtLookYaw = player.getYaw() + 145f;
                hurtLookTicks = 14;
            }
            hurtLookTicks--;
            motor.lookAtAngles(hurtLookYaw, 4f, Motor.LookMode.COMBAT);
            if (Motor.hasShieldEquipped(player) && Motor.isShieldReady(player)) {
                motor.selectShieldFriendlyMainHand();
                motor.requestHoldUse();
            }
            activeStatus = "checking behind after hit";
            return true;
        } else {
            hurtLookTicks = 0;
        }

        // 5. Auto-eat carried food when hurt or hungry (never while a hostile is swinging on us)
        boolean emergencyFood = player.getHealth() < 8.5f || player.getHungerManager().getFoodLevel() <= 6;
        boolean needFood = (player.getHealth() < 16.0f && player.getHungerManager().getFoodLevel() < 20)
            || player.getHungerManager().getFoodLevel() <= 12;

        if (eating) {
            eatingTicks++;
            int slot = motor.findHotbarFood(emergencyFood);
            if (slot < 0 || !needFood || eatingTicks > 60) {
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
            // If edible food is in backpack (slots 9..35), swap it smoothly into hotbar so we can eat!
            if (GuiHands.countEdibleFood(player, emergencyFood) > 0 && !gui.isBusy()) {
                boolean allowRaw = emergencyFood;
                gui.startHotbarSwap(st -> Motor.foodScore(st, allowRaw) > 0);
                gui.tick();
                activeStatus = "moving food to hotbar";
                return true;
            }
        }

        return false;
    }

    private void trackVitalsAndShield(ClientPlayerEntity player) {
        float hp = player.getHealth();
        if (Float.isFinite(lastTrackedHealth) && hp < lastTrackedHealth - 0.01f && lastTrackedHealth > 0f) {
            damageTaken += (lastTrackedHealth - hp);
        }
        lastTrackedHealth = hp;

        if (player.isBlocking()) {
            shieldBlockingTicks++;
        }

        ItemStack shield = player.getOffHandStack().isOf(Items.SHIELD)
            ? player.getOffHandStack()
            : (player.getMainHandStack().isOf(Items.SHIELD) ? player.getMainHandStack() : ItemStack.EMPTY);
        if (!shield.isEmpty()) {
            int dmg = shield.getDamage();
            if (lastShieldDamage >= 0 && dmg > lastShieldDamage) {
                shieldBlocks++;
                recentBlockTicks = 18;
            }
            lastShieldDamage = dmg;
        } else {
            lastShieldDamage = -1;
        }
    }

    private boolean tryQuickEquipShield(ClientPlayerEntity player, List<CombatPlanner.ThreatInfo> threats) {
        if (player.getOffHandStack().isOf(Items.SHIELD)) return false;
        int hotbarShield = motor.findHotbarShield();
        if (hotbarShield >= 0 && client.currentScreen == null) {
            player.getInventory().selectedSlot = hotbarShield;
            if (motor.swapHands()) {
                return true;
            }
        }
        // If shield is in backpack and nearest threat is still > 7m away, equip via inventory screen!
        if (hotbarShield < 0 && GuiHands.countItem(player, Items.SHIELD) > 0 && !gui.isBusy()) {
            double nearest = Double.POSITIVE_INFINITY;
            for (CombatPlanner.ThreatInfo t : threats) nearest = Math.min(nearest, t.dist());
            if (nearest > 7.5) {
                gui.startEquipOffhand(st -> st.isOf(Items.SHIELD));
                gui.tick();
                return true;
            }
        }
        return false;
    }

    private static boolean hasThreatWithin(List<CombatPlanner.ThreatInfo> threats, double maxDist) {
        for (CombatPlanner.ThreatInfo t : threats) {
            if (!t.occluded() && t.dist() <= maxDist) return true;
            if (t.occluded() && t.dist() <= Math.min(maxDist, 10.5)) return true;
        }
        return false;
    }

    // ===================== COMBAT ENGINE =====================

    private void handleHostileEncounter(
        ClientPlayerEntity player,
        ClientWorld world,
        List<CombatPlanner.ThreatInfo> threats,
        boolean incomingArrow,
        int currentTick
    ) {
        lastEscape = CombatPlanner.evaluateEscapeBearings(
            player.getX(), player.getBlockY(), player.getZ(), threats, perception.combatFlowProbe()
        );

        boolean hasShield = Motor.hasShieldEquipped(player);
        boolean shieldReady = Motor.isShieldReady(player);
        int shelterBlocks = Motor.countShelterBlocks(player);
        boolean hasDigTool = Motor.hasDigTool(player);
        boolean hasFood = GuiHands.countEdibleFood(player, true) > 0;

        CombatPlanner.CombatContext ctx = new CombatPlanner.CombatContext(
            player.getHealth(),
            player.getMaxHealth(),
            player.getHungerManager().getFoodLevel(),
            hasFood,
            Motor.bestHotbarWeaponScore(player),
            hasShield,
            shieldReady,
            player.getArmor(),
            shelterBlocks,
            hasDigTool,
            lastEscape.trapped(),
            lastEscape.bestScore(),
            combatStance,
            threats,
            incomingArrow
        );

        CombatPlanner.TacticalAction action = CombatPlanner.decideAction(ctx);
        lastAction = action;
        if (action != CombatPlanner.TacticalAction.FLEE) {
            fleeStuckTicks = 0;
            fleeLastPos = null;
        }
        CombatPlanner.ThreatInfo primary = CombatPlanner.pickPrimaryThreat(threats);
        LivingEntity liveTarget = primary == null ? null : perception.findVisibleHostileById(primary.entityId());

        switch (action) {
            case EMERGENCY_SHELTER -> {
                beginShelter(player, world);
                if (shelterState != ShelterState.NONE) {
                    tickShelter(player, world, currentTick);
                    return;
                }
                executeFlee(player, threats, hasShield && shieldReady, incomingArrow);
            }
            case CREEPER_BLOCK -> {
                executeCreeperBlock(player, primary, liveTarget);
            }
            case CREEPER_KITE -> {
                executeCreeperKite(player, primary, liveTarget, threats);
            }
            case FLEE -> {
                executeFlee(player, threats, hasShield && shieldReady, incomingArrow);
            }
            case SHIELD_HOLD -> {
                executeShieldHold(player, primary, liveTarget, threats, incomingArrow);
            }
            case SHIELD_ADVANCE -> {
                executeShieldAdvance(player, primary, liveTarget, threats);
            }
            case CAUTIOUS_PEEK -> {
                executeCautiousPeek(player, primary, hasShield && shieldReady);
            }
            case FIGHT -> {
                executeMeleeFight(player, primary, liveTarget, threats, hasShield && shieldReady);
            }
        }
    }

    private void executeCreeperBlock(ClientPlayerEntity player, CombatPlanner.ThreatInfo primary, LivingEntity liveTarget) {
        Vec3d aim = liveTarget != null
            ? Motor.entityAimPoint(liveTarget)
            : (primary != null ? new Vec3d(primary.x(), primary.y() + 0.9, primary.z()) : player.getEyePos());
        motor.lookAtPoint(aim, Motor.LookMode.COMBAT);
        motor.selectShieldFriendlyMainHand();
        motor.requestHoldUse();
        motor.requestSneak();
        activeStatus = "blocking creeper blast with shield";
    }

    private void executeCreeperKite(
        ClientPlayerEntity player,
        CombatPlanner.ThreatInfo primary,
        LivingEntity liveTarget,
        List<CombatPlanner.ThreatInfo> threats
    ) {
        if (liveTarget == null || primary == null) {
            executeFlee(player, threats, Motor.hasShieldEquipped(player) && Motor.isShieldReady(player), false);
            return;
        }
        double dist = primary.dist();
        boolean swelling = primary.creeperSwelling() || primary.creeperFuse() > 0.08f;

        if (creeperRetreatTicks <= 0 && !swelling && dist <= 3.9) {
            // Crisp sprint-knockback strike, then IMMEDIATELY sprint outside blast radius!
            motor.selectBestWeapon();
            motor.lookAtPoint(Motor.entityAimPoint(liveTarget), Motor.LookMode.COMBAT);
            if (dist > 2.65) {
                double dx = liveTarget.getX() - player.getX();
                double dz = liveTarget.getZ() - player.getZ();
                double len = Math.max(1e-4, Math.hypot(dx, dz));
                if (isSafeCombatStep(player, dx / len, dz / len, threats, liveTarget.getId())) {
                    motor.moveRelativeToYaw(dx, dz, true, false);
                }
            }
            if (motor.attackEntity(liveTarget, 0.85f)) {
                creeperRetreatTicks = 28;
            }
            activeStatus = "sprint-kiting creeper";
            return;
        }

        // Immediate sprint-retreat along combat-flow safe bearing (avoiding cliffs!)
        if (swelling && dist < 4.3 && lastEscape.trapped() && Motor.hasShieldEquipped(player) && Motor.isShieldReady(player)) {
            executeCreeperBlock(player, primary, liveTarget);
            return;
        }
        Vec3d escapePos = player.getPos().add(lastEscape.dirX() * 6.0, 0, lastEscape.dirZ() * 6.0);
        motor.moveToward(escapePos, true, shouldJumpToward(player, escapePos), false, true);
        activeStatus = "evading creeper";
    }

    private void executeFlee(
        ClientPlayerEntity player,
        List<CombatPlanner.ThreatInfo> threats,
        boolean shieldUsable,
        boolean incomingArrow
    ) {
        if (incomingArrow && shieldUsable) {
            Entity arrow = perception.incomingProjectiles().isEmpty() ? null : perception.incomingProjectiles().get(0);
            if (arrow != null) {
                motor.lookAtPoint(arrow.getPos(), Motor.LookMode.COMBAT);
                motor.selectShieldFriendlyMainHand();
                motor.requestHoldUse();
                activeStatus = "blocking arrow during retreat";
                return;
            }
        }
        Vec3d pos = player.getPos();
        if (fleeLastPos == null || Math.hypot(pos.x - fleeLastPos.x, pos.z - fleeLastPos.z) > 0.45) {
            fleeLastPos = pos;
            fleeStuckTicks = 0;
        } else if (++fleeStuckTicks >= 40) {
            // Physically wedged while fleeing (e.g., narrow cave/staircase blocked by hostile):
            // seal off immediately if we can shelter, otherwise fight/knock back a non-swelling melee threat!
            fleeStuckTicks = 0;
            fleeLastPos = pos;
            int blocks = Motor.countShelterBlocks(player);
            boolean canShelter = blocks >= 1 && (blocks >= 4 || Motor.hasDigTool(player));
            if (canShelter && client.world != null) {
                beginShelter(player, client.world);
                if (shelterState != ShelterState.NONE) {
                    activeStatus = "sealing shelter after blocked retreat";
                    return;
                }
            }
            CombatPlanner.ThreatInfo primary = CombatPlanner.pickPrimaryThreat(threats);
            LivingEntity liveTarget = primary == null ? null : perception.findVisibleHostileById(primary.entityId());
            if (primary != null && liveTarget != null && primary.dist() <= 3.8 && player.getHealth() >= 8.0f) {
                executeMeleeFight(player, primary, liveTarget, threats, shieldUsable);
                return;
            }
        }
        Vec3d escapePos = player.getPos().add(lastEscape.dirX() * 6.0, 0, lastEscape.dirZ() * 6.0);
        motor.moveToward(escapePos, true, shouldJumpToward(player, escapePos), false, true);
        activeStatus = "retreating from hostile";
    }

    private void executeShieldHold(
        ClientPlayerEntity player,
        CombatPlanner.ThreatInfo primary,
        LivingEntity liveTarget,
        List<CombatPlanner.ThreatInfo> threats,
        boolean incomingArrow
    ) {
        Vec3d aim = null;
        if (incomingArrow && !perception.incomingProjectiles().isEmpty()) {
            aim = perception.incomingProjectiles().get(0).getPos();
        } else if (liveTarget != null) {
            aim = Motor.entityAimPoint(liveTarget);
        } else if (primary != null) {
            aim = new Vec3d(primary.x(), primary.y() + 1.0, primary.z());
        }
        if (aim != null) {
            motor.lookAtPoint(aim, Motor.LookMode.COMBAT);
        }
        motor.selectShieldFriendlyMainHand();
        motor.requestHoldUse();
        // Gently backpedal / sidestep if a melee threat is right on us and footing is safe
        if (primary != null && !primary.kind().isRanged() && primary.dist() < 2.8) {
            double bx = player.getX() - primary.x();
            double bz = player.getZ() - primary.z();
            double len = Math.max(1e-4, Math.hypot(bx, bz));
            if (isSafeCombatStep(player, bx / len, bz / len, threats, primary.entityId())) {
                motor.moveRelativeToYaw(bx, bz, false, false);
            }
        }
        activeStatus = incomingArrow ? "blocking incoming arrow" : "holding shield";
    }

    private void executeShieldAdvance(
        ClientPlayerEntity player,
        CombatPlanner.ThreatInfo primary,
        LivingEntity liveTarget,
        List<CombatPlanner.ThreatInfo> threats
    ) {
        if (liveTarget == null || primary == null) {
            executeCautiousPeek(player, primary, true);
            return;
        }
        motor.lookAtPoint(Motor.entityAimPoint(liveTarget), Motor.LookMode.COMBAT);
        double dx = liveTarget.getX() - player.getX();
        double dz = liveTarget.getZ() - player.getZ();
        double horiz = Math.max(1e-4, Math.hypot(dx, dz));
        double nx = dx / horiz;
        double nz = dz / horiz;

        shieldAdvanceCycle = (shieldAdvanceCycle + 1) % 34;
        // Raise shield when skeleton is drawing, arrow incoming, or during defensive phase of cycle;
        // drop briefly right after blocking an arrow to sprint-close!
        boolean raiseShield = perception.hasIncomingArrow()
            || (recentBlockTicks <= 0 && (primary.rangedDrawing() || shieldAdvanceCycle < 22));

        if (raiseShield) {
            motor.selectShieldFriendlyMainHand();
            motor.requestHoldUse();
            // Advance slightly diagonally with shield raised (blocking arrows while closing!)
            double sx = nx * 0.8 + (-nz * strafeSign) * 0.45;
            double sz = nz * 0.8 + (nx * strafeSign) * 0.45;
            double sLen = Math.max(1e-4, Math.hypot(sx, sz));
            if (isSafeCombatStep(player, sx / sLen, sz / sLen, threats, liveTarget.getId())) {
                motor.moveRelativeToYaw(sx, sz, false, player.horizontalCollision);
            }
            activeStatus = "shield-advancing on " + primary.kind().wireName();
        } else {
            // Brief post-block sprint push to close distance before next arrow!
            motor.selectBestWeapon();
            if (isSafeCombatStep(player, nx, nz, threats, liveTarget.getId())) {
                motor.moveRelativeToYaw(nx, nz, horiz > 3.4, shouldJumpDirection(player, nx, nz));
            }
            activeStatus = "closing distance on " + primary.kind().wireName();
        }
    }

    private void executeCautiousPeek(ClientPlayerEntity player, CombatPlanner.ThreatInfo primary, boolean shieldUsable) {
        if (primary != null) {
            Vec3d aim = new Vec3d(primary.x(), primary.y() + 1.0, primary.z());
            motor.lookAtPoint(aim, Motor.LookMode.COMBAT);
            if (shieldUsable) {
                motor.selectShieldFriendlyMainHand();
                motor.requestHoldUse();
            }
            // Gently strafe sideways to peek around cover pillar/tree without turning our back!
            double dx = primary.x() - player.getX();
            double dz = primary.z() - player.getZ();
            double len = Math.max(1e-4, Math.hypot(dx, dz));
            double px = (-dz / len) * strafeSign;
            double pz = (dx / len) * strafeSign;
            if (isSafeCombatStep(player, px, pz, List.of(), -1)) {
                motor.moveRelativeToYaw(px, pz, false, false);
            } else if (isSafeCombatStep(player, -px, -pz, List.of(), -1)) {
                strafeSign = -strafeSign;
                motor.moveRelativeToYaw(-px, -pz, false, false);
            }
            activeStatus = "cautious peek for occluded " + primary.kind().wireName();
        } else {
            activeStatus = "holding guard";
        }
    }

    private void executeMeleeFight(
        ClientPlayerEntity player,
        CombatPlanner.ThreatInfo primary,
        LivingEntity target,
        List<CombatPlanner.ThreatInfo> threats,
        boolean shieldUsable
    ) {
        if (target == null || primary == null) {
            executeCautiousPeek(player, primary, shieldUsable);
            return;
        }

        double dx = target.getX() - player.getX();
        double dz = target.getZ() - player.getZ();
        double horiz = Math.max(1e-4, Math.hypot(dx, dz));
        double nx = dx / horiz;
        double nz = dz / horiz;

        int closeThreats = 0;
        for (CombatPlanner.ThreatInfo t : threats) {
            if (t.dist() <= 7.0) closeThreats++;
        }

        boolean isBaby = primary.kind() == CombatPlanner.ThreatKind.BABY_ZOMBIE;
        boolean isRanged = primary.kind().isRanged();
        double boxDist = Motor.distanceToBox(player.getEyePos(), target.getBoundingBox());
        float cooldown = player.getAttackCooldownProgress(0.5f);
        float minSwingCooldown = (isBaby && boxDist < 2.2) ? 0.80f : 0.90f;

        // Smooth aim at bounding-box center (tracks low hitboxes like baby zombies & spiders!)
        motor.lookAtPoint(Motor.entityAimPoint(target), Motor.LookMode.COMBAT);

        // Active shield rhythm between swings when fighting multiple mobs, baby zombies, or close melee!
        boolean wantBlockNow = shieldUsable
            && cooldown < 0.78f
            && (closeThreats >= 2 || isBaby || (boxDist < 3.4 && !isRanged));

        if (wantBlockNow) {
            motor.selectShieldFriendlyMainHand();
            motor.requestHoldUse();
        } else {
            motor.selectBestWeapon();
            motor.attackEntity(target, minSwingCooldown);
        }

        // Footwork: approach, perpendicular strafe vs unshielded skeleton, or safe backpedal/strafe!
        if (horiz > 2.75) {
            double moveX = nx;
            double moveZ = nz;
            if (isRanged && !shieldUsable && horiz > 3.8) {
                // Perpendicular weaving while closing on an unshielded skeleton!
                moveX = nx * 0.72 + (-nz * strafeSign) * 0.68;
                moveZ = nz * 0.72 + (nx * strafeSign) * 0.68;
            }
            double mLen = Math.max(1e-4, Math.hypot(moveX, moveZ));
            if (isSafeCombatStep(player, moveX / mLen, moveZ / mLen, threats, target.getId())) {
                boolean sprint = !wantBlockNow && horiz > 3.6;
                boolean jump = shouldJumpDirection(player, moveX / mLen, moveZ / mLen);
                motor.moveRelativeToYaw(moveX, moveZ, sprint, jump);
            } else {
                // Sidestep around an obstacle/ledge
                double sx = -nz * strafeSign;
                double sz = nx * strafeSign;
                if (isSafeCombatStep(player, sx, sz, threats, target.getId())) {
                    motor.moveRelativeToYaw(sx, sz, false, player.horizontalCollision);
                }
            }
        } else if (horiz < 1.85 || cooldown < 0.74f) {
            // Backpedal / strafe between swings while avoiding cliffs and secondary hostiles!
            double bx = -nx;
            double bz = -nz;
            double sx = -nz * strafeSign;
            double sz = nx * strafeSign;
            if (isSafeCombatStep(player, bx, bz, threats, target.getId())) {
                motor.moveRelativeToYaw(bx, bz, false, false);
            } else if (isSafeCombatStep(player, sx, sz, threats, target.getId())) {
                motor.moveRelativeToYaw(sx, sz, false, false);
            } else if (isSafeCombatStep(player, -sx, -sz, threats, target.getId())) {
                strafeSign = -strafeSign;
                motor.moveRelativeToYaw(-sx, -sz, false, false);
            }
        } else if (!wantBlockNow && closeThreats == 1 && !isBaby && player.getHealth() >= 14.0f
                && player.isOnGround() && cooldown >= 0.56f && cooldown <= 0.82f && boxDist <= 3.1
                && isSafeCombatStep(player, nx * 0.4, nz * 0.4, threats, target.getId())) {
            // Safe 1v1 jump-crit timing when healthy on clear ground!
            motor.requestJump();
        }

        activeStatus = (wantBlockNow ? "shield-fighting " : "fighting ") + target.getType().getName().getString();
    }

    // ===================== EMERGENCY SHELTER / BURROW-IN =====================

    private void beginShelter(ClientPlayerEntity player, ClientWorld world) {
        if (player == null || world == null) return;
        BlockPos feet = player.getBlockPos();
        int blocks = Motor.countShelterBlocks(player);
        boolean hasDig = Motor.hasDigTool(player);
        BlockState under = world.getBlockState(feet.down());
        boolean floorDiggable = !Perception.isUnbreakable(under)
            && !perception.isNearKnownLava(feet.getX(), feet.getY() - 1, feet.getZ())
            && !perception.isNearKnownFluidAboveOrSide(feet.getX(), feet.getY() - 1, feet.getZ());

        CombatPlanner.ShelterMode mode = CombatPlanner.chooseShelterMode(
            feet.getX(), feet.getY(), feet.getZ(), blocks, hasDig, floorDiggable, perception.combatFlowProbe()
        );
        if (mode == CombatPlanner.ShelterMode.NONE) {
            return;
        }
        shelterState = ShelterState.BUILDING;
        shelterMode = mode;
        shelterAnchor = feet.toImmutable();
        shelterStartY = feet.getY();
        shelterBuildTicks = 0;
        shelterBlockedTicks = 0;
        shelterSealedTicks = 0;
        shelterUnsealTicks = 0;
    }

    private boolean tickShelter(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        // Allow GuiHands hotbar swaps (for blocks or food) inside shelter!
        if (gui.isBusy()) {
            gui.tick();
            activeStatus = "preparing shelter supplies";
            return true;
        }
        if (gui.state() == GuiHands.State.DONE || gui.state() == GuiHands.State.FAILED) {
            gui.abort();
        }

        BlockPos feet = player.getBlockPos();
        if (isShelterSealed(world, feet)) {
            shelterEverSealed = true;
            if (isShelterRoofed(world, feet)) shelterEverRoofed = true;
            if (shelterState == ShelterState.BUILDING) {
                shelterState = ShelterState.SEALED_HEALING;
                shelterAnchor = feet.toImmutable();
                shelterSealedTicks = 0;
            }
        }

        switch (shelterState) {
            case BUILDING -> {
                shelterBuildTicks++;
                if (shelterBuildTicks > 180) {
                    // Timed out trying to build — abort back to combat/flee
                    shelterState = ShelterState.NONE;
                    return false;
                }
                return tickShelterBuild(player, world);
            }
            case SEALED_HEALING -> {
                return tickShelterSealedHealing(player, world);
            }
            case UNSEALING -> {
                return tickShelterUnseal(player, world);
            }
            default -> {
                return false;
            }
        }
    }

    private boolean tickShelterBuild(ClientPlayerEntity player, ClientWorld world) {
        if (shelterAnchor == null) shelterAnchor = player.getBlockPos().toImmutable();

        // Ensure a shelter building block is in hotbar (if carried in backpack, swap!)
        int blockSlot = motor.findHotbarShelterBlock();
        if (blockSlot < 0) {
            if (Motor.countShelterBlocks(player) > 0) {
                gui.startHotbarSwap(Motor::isShelterBlock);
                gui.tick();
                activeStatus = "grabbing shelter blocks";
                return true;
            }
            shelterState = ShelterState.NONE;
            if (combatStance == CombatPlanner.CombatStance.SHELTER) {
                combatStance = CombatPlanner.CombatStance.AUTO;
            }
            return false;
        }

        if (shelterMode == CombatPlanner.ShelterMode.BURROW_DOWN) {
            return tickBurrowDown(player, world, blockSlot);
        }
        return tickBoxOrCorner(player, world, blockSlot);
    }

    private boolean tickBoxOrCorner(ClientPlayerEntity player, ClientWorld world, int blockSlot) {
        BlockPos feet = shelterAnchor;
        // If knocked to a different cell, re-anchor cleanly if we haven't sealed walls yet
        if (player.getBlockPos().getSquaredDistance(feet) > 1.5) {
            shelterAnchor = player.getBlockPos().toImmutable();
            feet = shelterAnchor;
        }

        // Center cleanly over shelterAnchor so player bounding box never overlaps adjacent wall cells!
        double cx = feet.getX() + 0.5;
        double cz = feet.getZ() + 0.5;
        double offX = cx - player.getX();
        double offZ = cz - player.getZ();
        if (Math.hypot(offX, offZ) > 0.18) {
            motor.moveRelativeToYaw(offX, offZ, false, false);
            motor.requestSneak();
        }

        // Order cardinal directions closest to primary visible threat FIRST (immediate barrier!)
        final BlockPos anchorPos = feet;
        Vec3d threatPos = null;
        if (!perception.visibleHostiles().isEmpty()) {
            threatPos = perception.visibleHostiles().get(0).getPos();
        }
        List<Direction> dirs = new ArrayList<>(List.of(CARDINALS));
        if (threatPos != null) {
            final Vec3d tp = threatPos;
            dirs.sort(Comparator.comparingDouble(d -> Vec3d.ofCenter(anchorPos.offset(d)).squaredDistanceTo(tp)));
        }

        // Phase 1: Seal threat-facing direction FULL 2-high FIRST (immediately blocks BOTH melee & skeleton arrows!),
        // then seal remaining cardinal feet-level and head-level walls!
        List<BlockPos> wallOrder = new ArrayList<>(8);
        if (!dirs.isEmpty()) {
            Direction primaryDir = dirs.get(0);
            wallOrder.add(feet.offset(primaryDir));
            wallOrder.add(feet.up().offset(primaryDir));
        }
        for (int dy = 0; dy <= 1; dy++) {
            for (int i = 1; i < dirs.size(); i++) {
                wallOrder.add(feet.up(dy).offset(dirs.get(i)));
            }
        }
        int unplaceableWalls = 0;
        for (BlockPos target : wallOrder) {
            if (isSolidWall(world.getBlockState(target))) continue;

            // Check if a hostile mob is standing inside this target wall cell!
            List<Entity> blockers = world.getOtherEntities(player, new Box(target),
                e -> e instanceof LivingEntity && e.isAlive());
            if (!blockers.isEmpty()) {
                shelterBlockedTicks++;
                if (shelterBlockedTicks > 24 && canBurrowDown(world, feet)) {
                    shelterMode = CombatPlanner.ShelterMode.BURROW_DOWN;
                    shelterStartY = feet.getY();
                    shelterBlockedTicks = 0;
                    activeStatus = "switching to emergency burrow";
                    return true;
                }
                // Knock the blocking mob back so we can seal!
                motor.selectBestWeapon();
                motor.attackEntity(blockers.get(0), 0.65f);
                activeStatus = "clearing doorway to seal shelter";
                return true;
            }

            // Skip wall cells hanging over air/ravine with no adjacent placement face so we seal supported walls first!
            if (motor.findPlacementHit(target) == null) {
                unplaceableWalls++;
                continue;
            }

            if (motor.placeBlockAt(target, blockSlot)) {
                shelterBlocksPlaced++;
                shelterBlockedTicks = 0;
                perception.recordObserved(target, world.getBlockState(target), false);
            } else {
                shelterBlockedTicks++;
                if (shelterBlockedTicks > 24 && canBurrowDown(world, feet)) {
                    shelterMode = CombatPlanner.ShelterMode.BURROW_DOWN;
                    shelterStartY = feet.getY();
                    shelterBlockedTicks = 0;
                    activeStatus = "switching to emergency burrow";
                    return true;
                }
                if (shelterBlockedTicks > 48) {
                    shelterState = ShelterState.NONE;
                    shelterBlockedTicks = 0;
                    activeStatus = "leaving unsealable ledge";
                    return false;
                }
            }
            activeStatus = "sealing emergency shelter walls";
            return true;
        }
        // Remaining open walls hang over a drop with no placement face: burrow down into rock ledge or exit cleanly!
        if (unplaceableWalls > 0) {
            shelterBlockedTicks++;
            if (canBurrowDown(world, feet)) {
                shelterMode = CombatPlanner.ShelterMode.BURROW_DOWN;
                shelterStartY = feet.getY();
                shelterBlockedTicks = 0;
                activeStatus = "burrowing into ledge for shelter";
                return true;
            }
            if (shelterBlockedTicks > 30) {
                shelterState = ShelterState.NONE;
                shelterBlockedTicks = 0;
                activeStatus = "leaving unsealable ledge";
                return false;
            }
        }

        // Phase 2: Spider-proof & arrow-proof ROOF at feet.up(2)!
        BlockPos roof = feet.up(2);
        if (!isSolidWall(world.getBlockState(roof))) {
            if (motor.findPlacementHit(roof) != null) {
                if (motor.placeBlockAt(roof, blockSlot)) {
                    shelterBlocksPlaced++;
                    perception.recordObserved(roof, world.getBlockState(roof), false);
                }
                activeStatus = "capping emergency shelter roof";
                return true;
            }
            // No 3-high wall adjacent to roof yet: jump and place ONE support block at feet.up(2).offset(dir)!
            for (Direction d : dirs) {
                BlockPos wallTop = feet.up(1).offset(d);
                BlockPos supportCap = feet.up(2).offset(d);
                if (isSolidWall(world.getBlockState(wallTop)) && !isSolidWall(world.getBlockState(supportCap))) {
                    motor.requestJump();
                    Vec3d aim = Vec3d.ofCenter(wallTop).add(0, 0.48, 0);
                    motor.lookAtPoint(aim, Motor.LookMode.FINE);
                    if (motor.placeBlockAt(supportCap, blockSlot)) {
                        shelterBlocksPlaced++;
                    }
                    activeStatus = "raising shelter roof support";
                    return true;
                }
            }
            // Fallback: burrow 1 block down so walls are naturally 3 high around roof!
            if (canBurrowDown(world, feet)) {
                shelterMode = CombatPlanner.ShelterMode.BURROW_DOWN;
                shelterStartY = feet.getY();
                return true;
            }
        }

        // Check sealed!
        if (isShelterSealed(world, feet)) {
            shelterEverSealed = true;
            shelterEverRoofed = true;
            shelterState = ShelterState.SEALED_HEALING;
            shelterSealedTicks = 0;
            activeStatus = "emergency shelter sealed";
            return true;
        }
        activeStatus = "building emergency shelter";
        return true;
    }

    private boolean tickBurrowDown(ClientPlayerEntity player, ClientWorld world, int blockSlot) {
        BlockPos feet = player.getBlockPos();
        int depth = shelterStartY - feet.getY();

        // Center cleanly over feet column
        double offX = (feet.getX() + 0.5) - player.getX();
        double offZ = (feet.getZ() + 0.5) - player.getZ();
        if (Math.hypot(offX, offZ) > 0.16) {
            motor.moveRelativeToYaw(offX, offZ, false, false);
            motor.requestSneak();
        }

        // Check if we already have solid surrounding walls AND a side support for roof at feet.up(2)!
        boolean wallsClosed = allCardinalWallsSolid(world, feet, 0) && allCardinalWallsSolid(world, feet, 1);
        boolean canCapNow = wallsClosed && motor.findPlacementHit(feet.up(2)) != null;

        if (depth >= 3 || canCapNow) {
            BlockPos roof = feet.up(2);
            if (!isSolidWall(world.getBlockState(roof))) {
                if (motor.placeBlockAt(roof, blockSlot)) {
                    shelterBlocksPlaced++;
                    perception.recordObserved(roof, world.getBlockState(roof), false);
                }
                activeStatus = "capping emergency burrow";
                return true;
            }
            if (isShelterSealed(world, feet)) {
                shelterEverSealed = true;
                shelterEverRoofed = true;
                shelterAnchor = feet.toImmutable();
                shelterState = ShelterState.SEALED_HEALING;
                shelterSealedTicks = 0;
                activeStatus = "emergency burrow sealed";
                return true;
            }
            // Any side still open (e.g. stepped down into a hillside) -> finish sealing with BOX_OR_CORNER
            shelterMode = CombatPlanner.ShelterMode.BOX_OR_CORNER;
            shelterAnchor = feet.toImmutable();
            return true;
        }

        // Dig next block directly underfoot (checking safety first!)
        BlockPos under = feet.down();
        if (!canBurrowDown(world, feet)) {
            shelterMode = CombatPlanner.ShelterMode.BOX_OR_CORNER;
            shelterAnchor = feet.toImmutable();
            return true;
        }
        motor.mineBlock(under, true, false);
        activeStatus = "burrowing emergency shelter (" + depth + "/3)";
        return true;
    }

    private boolean tickShelterSealedHealing(ClientPlayerEntity player, ClientWorld world) {
        shelterSealedTicks++;
        BlockPos feet = player.getBlockPos();

        // Repair any breached wall or roof immediately (e.g. if a creeper damaged a wall)
        if (!isShelterSealed(world, feet)) {
            shelterState = ShelterState.BUILDING;
            shelterAnchor = feet.toImmutable();
            shelterMode = CombatPlanner.ShelterMode.BOX_OR_CORNER;
            return tickShelterBuild(player, world);
        }

        // Eat carried food to recover health & hunger safely inside!
        int foodLevel = player.getHungerManager().getFoodLevel();
        float hp = player.getHealth();
        boolean canEatNow = foodLevel < 20 && (hp < 18.5f || foodLevel <= 16);
        if (canEatNow) {
            int foodSlot = motor.findHotbarFood(true);
            if (foodSlot >= 0) {
                player.getInventory().selectedSlot = foodSlot;
                motor.requestHoldUse();
                activeStatus = "eating inside sealed shelter";
                return true;
            }
            if (GuiHands.countEdibleFood(player, true) > 0) {
                gui.startHotbarSwap(st -> Motor.foodScore(st, true) > 0);
                gui.tick();
                activeStatus = "grabbing food in shelter";
                return true;
            }
        }

        boolean recoveringHp = hp < 16.0f && (foodLevel >= 18 || GuiHands.countEdibleFood(player, true) > 0);
        boolean holdForStrategist = combatStance == CombatPlanner.CombatStance.SHELTER || manualShelterTicks > 0;
        boolean holdMinSafety = shelterSealedTicks < 100;

        if ((holdForStrategist || recoveringHp || holdMinSafety) && shelterSealedTicks < 420) {
            // Gently glance around inside while regenerating HP
            motor.lookAtAngles(player.getYaw() + (float) Math.sin(shelterSealedTicks * 0.08) * 1.5f, 4f, Motor.LookMode.SCAN);
            activeStatus = recoveringHp ? "healing inside sealed shelter" : "holding inside sealed shelter";
            return true;
        }

        // Ready to safely unseal and exit!
        unsealDir = pickSafeUnsealDir(world, feet);
        shelterState = ShelterState.UNSEALING;
        shelterUnsealTicks = 0;
        activeStatus = "unsealing shelter to exit";
        return true;
    }

    private boolean tickShelterUnseal(ClientPlayerEntity player, ClientWorld world) {
        shelterUnsealTicks++;
        BlockPos feet = player.getBlockPos();
        if (shelterUnsealTicks > 140 || (shelterAnchor != null && feet.getSquaredDistance(shelterAnchor) >= 3.5)) {
            shelterState = ShelterState.NONE;
            if (combatStance == CombatPlanner.CombatStance.SHELTER) {
                combatStance = CombatPlanner.CombatStance.AUTO;
            }
            return false;
        }

        // If burrowed underground (startY > feet.y), break overhead cap and pillar out!
        if (feet.getY() < shelterStartY) {
            BlockPos roof = feet.up(2);
            if (!Perception.isPassable(world.getBlockState(roof))) {
                motor.mineBlock(roof, true, false);
                activeStatus = "unsealing burrow roof";
                return true;
            }
            int blockSlot = motor.findHotbarShelterBlock();
            if (blockSlot >= 0) {
                Vec3d center = Vec3d.ofBottomCenter(feet);
                if (Math.hypot(player.getX() - center.x, player.getZ() - center.z) > 0.15) {
                    motor.moveToward(center, false, false, true, false);
                } else {
                    player.getInventory().selectedSlot = blockSlot;
                    Vec3d downPoint = new Vec3d(feet.getX() + 0.5, feet.getY() - 0.01, feet.getZ() + 0.5);
                    motor.lookAtPoint(downPoint, Motor.LookMode.FINE);
                    boolean aimedAtFloor = player.getPitch() >= 84.0f
                        && client.crosshairTarget instanceof net.minecraft.util.hit.BlockHitResult bhr
                        && bhr.getType() == net.minecraft.util.hit.HitResult.Type.BLOCK
                        && bhr.getBlockPos().equals(feet.down())
                        && bhr.getSide() == Direction.UP;
                    if (aimedAtFloor) {
                        if (player.isOnGround()) {
                            motor.requestJump();
                        }
                        if (player.getY() >= feet.getY() + 1.01) {
                            motor.placeBlockAgainst(feet.down(), Direction.UP, downPoint, blockSlot);
                        }
                    }
                }
                activeStatus = "pillaring out of burrow";
                return true;
            }
            shelterState = ShelterState.NONE;
            if (combatStance == CombatPlanner.CombatStance.SHELTER) {
                combatStance = CombatPlanner.CombatStance.AUTO;
            }
            return false;
        }

        // Surface box/corner: break 2-high exit on unsealDir and walk out!
        BlockPos exitHead = shelterAnchor.up().offset(unsealDir);
        BlockPos exitFeet = shelterAnchor.offset(unsealDir);
        if (!Perception.isPassable(world.getBlockState(exitHead))) {
            motor.mineBlock(exitHead, true, false);
            activeStatus = "unsealing shelter exit";
            return true;
        }
        if (!Perception.isPassable(world.getBlockState(exitFeet))) {
            motor.mineBlock(exitFeet, true, false);
            activeStatus = "unsealing shelter exit";
            return true;
        }
        motor.moveToward(Vec3d.ofBottomCenter(exitFeet.offset(unsealDir)), false, player.horizontalCollision, false, true);
        activeStatus = "exiting shelter";
        return true;
    }

    private Direction pickSafeUnsealDir(ClientWorld world, BlockPos feet) {
        // Prefer breaking out on a side that isn't a thick cliff wall (softer / thinner wall)
        Direction best = Direction.SOUTH;
        float bestHardness = Float.POSITIVE_INFINITY;
        for (Direction d : CARDINALS) {
            BlockState s0 = world.getBlockState(feet.offset(d));
            BlockState s1 = world.getBlockState(feet.up().offset(d));
            if (Perception.isUnbreakable(s0) || Perception.isUnbreakable(s1)) continue;
            float h = s0.getHardness(world, feet.offset(d)) + s1.getHardness(world, feet.up().offset(d));
            if (s0.isToolRequired()) h += 20.0f;
            if (s1.isToolRequired()) h += 20.0f;
            if (h < bestHardness) {
                bestHardness = h;
                best = d;
            }
        }
        return best;
    }

    private boolean canBurrowDown(ClientWorld world, BlockPos feet) {
        BlockPos under = feet.down();
        BlockState st = world.getBlockState(under);
        if (!Perception.isSolidSupport(st) || Perception.isUnbreakable(st) || Perception.isHazardBlock(st)) {
            return false;
        }
        if (perception.isNearKnownLava(under.getX(), under.getY(), under.getZ())
                || perception.isNearKnownFluidAboveOrSide(under.getX(), under.getY(), under.getZ())) {
            return false;
        }
        return st.getHardness(world, under) <= 5.0f;
    }

    private static boolean isSolidWall(BlockState st) {
        return st != null && Perception.isSolidSupport(st);
    }

    private static boolean allCardinalWallsSolid(ClientWorld world, BlockPos feet, int dy) {
        for (Direction d : CARDINALS) {
            if (!isSolidWall(world.getBlockState(feet.up(dy).offset(d)))) return false;
        }
        return true;
    }

    static boolean isShelterRoofed(ClientWorld world, BlockPos feet) {
        return isSolidWall(world.getBlockState(feet.up(2)));
    }

    static boolean isShelterSealed(ClientWorld world, BlockPos feet) {
        return isSolidWall(world.getBlockState(feet.down()))
            && allCardinalWallsSolid(world, feet, 0)
            && allCardinalWallsSolid(world, feet, 1)
            && isShelterRoofed(world, feet);
    }

    // ===================== ENVIRONMENT / STEP SAFETY HELPERS =====================

    private void closeScreenIfOpen() {
        if (client.currentScreen != null) {
            gui.abort();
        }
    }

    private void handleLavaEscape(ClientPlayerEntity player, ClientWorld world) {
        int waterSlot = motor.findHotbarItem(Items.WATER_BUCKET);
        if (waterSlot >= 0) {
            player.getInventory().selectedSlot = waterSlot;
            motor.lookAtAngles(player.getYaw(), 82f, Motor.LookMode.COMBAT);
            if (player.getPitch() > 65f && client.interactionManager != null) {
                client.interactionManager.interactItem(player, Hand.MAIN_HAND);
                player.swingHand(Hand.MAIN_HAND);
            }
        }
        Vec3d bestExit = findSafeEscapeDirection(player, world, player.getPos(), true);
        motor.moveToward(bestExit, true, true, false, false);
    }

    private void handleDrownEscape(ClientPlayerEntity player, ClientWorld world) {
        motor.requestJump();
        Vec3d bank = findSafeEscapeDirection(player, world, player.getPos(), false);
        motor.moveToward(bank, false, true, false, true);
    }

    /** Check combat-flow step safety: no hazards, no solid wall/headroom block, no cliff drop-off, no walking into another threat! */
    private boolean isSafeCombatStep(
        ClientPlayerEntity player,
        double dirX,
        double dirZ,
        List<CombatPlanner.ThreatInfo> threats,
        int ignoreEntityId
    ) {
        double nx = player.getX() + dirX * 1.15;
        double nz = player.getZ() + dirZ * 1.15;
        int bx = (int) Math.floor(nx);
        int by = player.getBlockY();
        int bz = (int) Math.floor(nz);

        BlockState feet = perception.getObserved(bx, by, bz);
        BlockState head = perception.getObserved(bx, by + 1, bz);
        BlockState below = perception.getObserved(bx, by - 1, bz);
        BlockState below2 = perception.getObserved(bx, by - 2, bz);

        if (Perception.isHazardBlock(feet) || Perception.isHazardBlock(below)) return false;
        if (feet != null && !Perception.isPassable(feet)) {
            // Allow 1-block step-up only when head & upHead are clear
            BlockState upHead = perception.getObserved(bx, by + 2, bz);
            if (!(Perception.isSolidSupport(feet) && Perception.isPassable(head) && Perception.isPassable(upHead))) {
                return false;
            }
        } else {
            if (head != null && !Perception.isPassable(head)) return false;
            if (!(Perception.isSolidSupport(below) || Perception.isSolidSupport(below2))) return false;
        }

        // Avoid stepping right into a SECOND hostile!
        for (CombatPlanner.ThreatInfo t : threats) {
            if (t.entityId() == ignoreEntityId) continue;
            if (Math.hypot(nx - t.x(), nz - t.z()) < 2.2) return false;
        }
        return true;
    }

    private boolean shouldJumpDirection(ClientPlayerEntity player, double dirX, double dirZ) {
        if (player.horizontalCollision) return true;
        int bx = (int) Math.floor(player.getX() + dirX * 0.9);
        int bz = (int) Math.floor(player.getZ() + dirZ * 0.9);
        BlockState ahead = perception.getObserved(bx, player.getBlockY(), bz);
        return ahead != null && Perception.isSolidSupport(ahead);
    }

    private boolean shouldJumpToward(ClientPlayerEntity player, Vec3d dest) {
        if (player.horizontalCollision) return true;
        double dx = dest.x - player.getX();
        double dz = dest.z - player.getZ();
        double len = Math.hypot(dx, dz);
        if (len < 0.1) return false;
        return shouldJumpDirection(player, dx / len, dz / len);
    }

    private Vec3d findSafeEscapeDirection(ClientPlayerEntity player, ClientWorld world, Vec3d origin, boolean avoidLava) {
        BlockPos p = player.getBlockPos();
        BlockPos best = null;
        double bestDist = Double.POSITIVE_INFINITY;
        for (int dx = -4; dx <= 4; dx++) {
            for (int dz = -4; dz <= 4; dz++) {
                // Only dy = 0..1! A player in water cannot jump onto a dy = +2 cliff ledge!
                for (int dy = 0; dy <= 1; dy++) {
                    BlockPos cand = p.add(dx, dy, dz);
                    BlockState f = world.getBlockState(cand);
                    BlockState h = world.getBlockState(cand.up());
                    BlockState b = world.getBlockState(cand.down());
                    if (f.isAir() && f.getFluidState().isEmpty() && h.isAir() && h.getFluidState().isEmpty()
                            && Perception.isSolidSupport(b)) {
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
