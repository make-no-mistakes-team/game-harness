package io.gameharness.survival;

import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.AttributeModifiersComponent;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.ai.RangedAttackMob;
import net.minecraft.entity.attribute.EntityAttributes;
import net.minecraft.entity.mob.DrownedEntity;
import net.minecraft.entity.mob.EndermanEntity;
import net.minecraft.entity.mob.ZombieEntity;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/** Cave kit and weapon choices use the player's inventory; combat uses only the current view. */
final class AgentDefense {
    private static final int SHIELD_PLANKS = 6;
    private static final int COMBAT_VIEW_GRACE = 3;
    private static final long ZOMBIE_LOOK_NANOS = 1_200_000_000L;
    private static final float ZOMBIE_LOOK_PITCH = 10;
    private static final int MELEE_REORIENT_TICKS = 22;
    private static final long RANGED_ALERT_NANOS = 2_400_000_000L;
    private static final double SHORE_MELEE_CLEARANCE = 0.5;
    private static final float[] MELEE_ESCAPE_TURNS = {0, -42, 42, -80, 80};
    private static final double[] MELEE_FLOOR_ROWS = {0.42, 0.78, 1.25, 1.9, 2.55, 3.04};
    private static final Predicate<ItemStack> SHIELD = stack -> stack.isOf(Items.SHIELD);
    private static final Predicate<ItemStack> INGOT = stack -> stack.isOf(Items.IRON_INGOT);
    private static final Predicate<ItemStack> STONE = stack -> stack.isIn(ItemTags.STONE_TOOL_MATERIALS);

    private enum Armor {
        CHEST(Items.IRON_CHESTPLATE, EquipmentSlot.CHEST, "iron_chestplate", 8),
        LEGS(Items.IRON_LEGGINGS, EquipmentSlot.LEGS, "iron_leggings", 7),
        FEET(Items.IRON_BOOTS, EquipmentSlot.FEET, "iron_boots", 4),
        HEAD(Items.IRON_HELMET, EquipmentSlot.HEAD, "iron_helmet", 5);

        final Item item;
        final EquipmentSlot slot;
        final String recipe;
        final Predicate<ItemStack> matches;
        final int cost;
        final double protection;

        Armor(Item item, EquipmentSlot slot, String recipe, int cost) {
            this.item = item;
            this.slot = slot;
            this.recipe = recipe;
            this.cost = cost;
            matches = stack -> stack.isOf(item);
            protection = armorPoints(item.getComponents().getOrDefault(
                DataComponentTypes.ATTRIBUTE_MODIFIERS, AttributeModifiersComponent.DEFAULT), slot);
        }
    }

    private static final Armor[] ARMOR = Armor.values();
    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentHands hands;
    private String status;
    private boolean hadShield;
    private boolean combatSelecting;
    private int calmAfter;
    private int seekIronUntil;
    private int equipAfter;
    private int swapAfter;
    private int swapWaitUntil;
    private Armor wearing;
    private int wearUntil;
    private int wearAfter;
    private String workshopRecipe;
    private int workshopUntil;
    private int workshopAfter;
    private LivingEntity lastThreat;
    private int engagementStarted;
    private int lastEngaged;
    private int seenAt;
    private Vec3d aim;
    private AgentEars.ZombieCue zombieLook;
    private long zombieLookUntil;
    private int zombieLookAfter;
    private int zombieLookAligned;
    private float zombieLookYaw;
    private boolean rangedAudible, rangedUnderFire, rangedCoverTried;
    private boolean coverReceipt, rangedRetreatReceipt, rangedHitNow;
    private float rangedYaw, rangedPitch;
    private long rangedUntil;
    private int rangedSelectAfter;
    private BlockPos rangedCover;
    private Block rangedCoverBlock;
    private int rangedCoverUntil, rangedCoverSlot, rangedCoverCount;
    private final RangedFire rangedFire = new RangedFire();
    private final AgentEmergencyFootwork rangedFootwork = new AgentEmergencyFootwork();
    private Vec3d rangedBlockedAt;
    private boolean rangedFootworkStarted;
    private int rangedDriveTick = -1;
    private final RangedEpisode rangedEpisode = new RangedEpisode();
    private final RangedRetreat rangedRetreat = new RangedRetreat();
    private Vec3d rangedSource, rangedSurveyFrom;
    private BlockPos shelter;
    private BlockState shelterState, shelterUpper;
    private Vec3d shelterGoal;
    private boolean sheltered;
    private RangedWall rangedWall;
    private String rangedFootingRefusal, rangedWallRefusal;
    private int shelterScanAfter, shelterUntil, rangedSightAt;
    private float lastShotYaw, lastShotPitch;
    private AgentBody.OrdinaryGrade rangedGradeLook;
    private AgentSurfaceTread rangedGrade;
    private int rangedGradeLookBy;
    private final MeleeRecovery melee = new MeleeRecovery();
    private Vec3d meleeStart, meleeSurveyFrom;
    private LivingEntity meleeVisible, meleeAttacker;
    private float meleeAway = Float.NaN;
    private float meleeHeading, meleeImpulseLook;
    private AgentEars.MeleeCue meleeSound;
    private float meleeLane = Float.NaN;
    private int meleeTurn, meleeTurnSince, meleeSamples, meleeAttackerTick;
    private boolean meleeFreshHit, meleeEscapeFirst;
    private float meleeLookPitch;
    private String meleeRefusal;
    private Vec3d meleeDriveFrom;
    private int meleeDriveTick;
    private float meleeDriveYaw;
    private boolean meleeDriveConfirmed, meleeDrove;
    private double meleeMotionBefore;
    private AgentSurfaceTread meleeGrade;
    private AgentBody.OrdinaryGrade meleeGradeLook;
    private int meleeGradeLookBy;

    /** Repeated impacts survive missing frames and wet footing; only dry play can take back ownership. */
    static final class MeleeRecovery {
        private static final int QUIET_AFTER_HIT = 32;
        private static final int EVIDENCE_LIMIT = 64;
        private static final int PINNED_LIMIT = 100;
        enum Evidence { NONE, AMBIENT, CONTACT, IMPACT }
        enum Footing { DRY, WET, UNSETTLED, VEHICLE }
        enum DryAction { RETREAT, COUNTER, EMERGENCY, SURVEY, WAIT }

        private int lastEvidence = -EVIDENCE_LIMIT;
        private int lastHit = -QUIET_AFTER_HIT;
        private boolean active, pinned, shoreNeeded, settledBank;
        private float lastLoss;
        private boolean repeatedLoss;
        private long heardCue = Long.MIN_VALUE;
        private int impulseLookAtHit = Integer.MIN_VALUE;
        private int lookUntil;
        private float lookYaw;
        private final RangedRetreat retreat = new RangedRetreat();
        private float retreatAway = Float.NaN;
        private boolean retreatStarted;

        static boolean canSprint(double seen, double speed, int hunger, boolean sprinting) {
            return hunger > 6 && seen >= Math.max(sprinting ? 2.1 : 2.5, 1.4 + 3.2 * speed);
        }

        static DryAction dryAction(boolean grounded, boolean freshHit, boolean witnessedLane, boolean reachableHostile,
                                   boolean escapeFirst, boolean escapeBlocked) {
            boolean canMove = grounded && !freshHit;
            if (canMove && witnessedLane) return DryAction.RETREAT;
            if (reachableHostile) {
                if (!escapeFirst) return DryAction.COUNTER;
                if (!canMove || escapeBlocked) return DryAction.EMERGENCY;
            }
            return canMove ? DryAction.SURVEY : DryAction.WAIT;
        }

        boolean observeImpact(int tick, float loss, boolean critical, boolean separated, Footing footing) {
            repeatedLoss = active && tick - lastHit < QUIET_AFTER_HIT;
            lastLoss = loss;
            return observe(tick, Evidence.IMPACT, critical, separated, footing);
        }

        boolean escapeFirst(int tick, float health, boolean weapon, boolean shield) {
            // Actual HP loss already includes armor protection. Do not extrapolate
            // from the mob type, hurt animation, or from a requested strike.
            return !weapon || !shield && tick - lastHit < QUIET_AFTER_HIT
                && health <= lastLoss * (repeatedLoss ? 2 : 1);
        }

        void orientRetreat(int tick, float away, float facing, float walked, boolean visible) {
            // Recoil against a trunk or bank is not a new enemy position. Keep
            // the rolling exit through hits; only a seen hostile can veto it.
            if (retreatStarted && (!Float.isFinite(away) || Float.isFinite(retreatAway)
                    && (!visible || turnDifference(away, retreat.bearing()) < 112))) return;
            retreatAway = away;
            retreat.start(tick, away, facing);
            if (Float.isFinite(walked) && (!Float.isFinite(away) || turnDifference(walked, away) <= 92))
                retreat.prefer(tick, walked);
            retreatStarted = true;
        }

        AgentBody.HorizonTravel escapeWalk(Vec3d feet) { return retreat.walk(feet, null); }

        void reset() {
            lastEvidence = -EVIDENCE_LIMIT;
            lastHit = -QUIET_AFTER_HIT;
            active = pinned = shoreNeeded = settledBank = repeatedLoss = retreatStarted = false;
            lastLoss = 0;
            heardCue = Long.MIN_VALUE;
            impulseLookAtHit = Integer.MIN_VALUE;
            lookUntil = 0;
            retreatAway = Float.NaN;
            retreat.reset();
        }

        static boolean separatedShoreSwimmer(boolean dryGrounded, boolean inWater, boolean holdingTrident,
                                             boolean recentAttacker, double gapBelowFeet) {
            // Player attack reach is not reciprocal. Require a clear vertical gap below
            // the player's feet, with room for a small rise before melee boxes can overlap.
            return dryGrounded && inWater && !holdingTrident && !recentAttacker
                && gapBelowFeet >= SHORE_MELEE_CLEARANCE;
        }

        boolean observe(int tick, Evidence evidence, boolean critical, boolean separated, Footing footing) {
            if (footing == Footing.VEHICLE) {
                active = pinned = shoreNeeded = settledBank = false;
                return false;
            }
            boolean hurt = evidence == Evidence.IMPACT, close = evidence == Evidence.CONTACT;
            if (hurt || footing == Footing.WET) settledBank = false;
            if (!active || !critical || separated || settledBank) pinned = false;
            if (hurt) {
                pinned |= critical && !separated && active && tick - lastHit < QUIET_AFTER_HIT;
                lastHit = tick;
            }
            if (hurt || close) lastEvidence = tick;
            boolean dry = footing == Footing.DRY && !shoreNeeded;
            boolean quiet = tick - lastHit >= QUIET_AFTER_HIT;
            boolean expired = tick - lastEvidence >= (pinned ? PINNED_LIMIT : EVIDENCE_LIMIT);
            active = hurt || close || active && (!dry || !(quiet && (expired || separated || settledBank)));
            if (!active) shoreNeeded = settledBank = false;
            else if (footing == Footing.WET) shoreNeeded = true;
            return active;
        }

        boolean needsShore() { return shoreNeeded; }
        void leaveShore(boolean landed) {
            shoreNeeded = false;
            settledBank = landed;
        }

        boolean recentImpact(int tick) { return active && tick - lastHit <= 3; }

        float lookBearing(int tick, AgentEars.MeleeCue cue, float impulse) {
            if (cue != null && cue.heardAt() != heardCue) {
                heardCue = cue.heardAt();
                if (recentImpact(tick)) impulseLookAtHit = lastHit;
                lookYaw = cue.yaw();
                lookUntil = tick + MELEE_REORIENT_TICKS;
            } else if (tick >= lookUntil && recentImpact(tick) && impulseLookAtHit != lastHit && Float.isFinite(impulse)) {
                impulseLookAtHit = lastHit;
                lookYaw = impulse;
                lookUntil = tick + MELEE_REORIENT_TICKS;
            }
            return tick < lookUntil ? lookYaw : Float.NaN;
        }

        void finishLook() { lookUntil = 0; }

        static boolean checkedStride(boolean applied, boolean grounded, boolean hurt,
                                     double horizontal, double rise, double previousMotion) {
            return applied && grounded && !hurt && Math.abs(rise) < 0.055
                && horizontal > Math.max(0, previousMotion) + 0.035;
        }
    }

    AgentDefense(MinecraftClient client, AgentBody body, AgentHands hands) {
        this.client = client;
        this.body = body;
        this.hands = hands;
    }

    String status() {
        return status;
    }

    void markDanger(int tick) {
        calmAfter = tick + 20;
        stopZombieLook();
    }

    static boolean criticallyHurt(LivingEntity player) { return player.getHealth() <= 7; }

    void stopZombieLook() { zombieLook = null; }

    /** Takes only the current, sight-checked target from AgentBody. Never infer a route through terrain. */
    boolean separatedShoreSwimmer(LivingEntity visible, int tick) {
        if (!(visible instanceof DrownedEntity drowned)) return false;
        var player = client.player;
        boolean dryGrounded = player.isOnGround() && !player.isTouchingWater() && !player.hasVehicle()
            && !player.isInLava();
        return MeleeRecovery.separatedShoreSwimmer(dryGrounded, drowned.isSwimming() || drowned.isTouchingWater(),
            holdsTrident(drowned), meleeAttacker(tick) == drowned, player.getY() - drowned.getBoundingBox().maxY);
    }

    private static boolean holdsTrident(LivingEntity visible) {
        return visible instanceof DrownedEntity && visible.isHolding(Items.TRIDENT);
    }

    boolean observeMelee(AgentEars ears, LivingEntity visible, boolean shoreSeparated, float healthLost,
                         boolean healingMeal, int tick, Predicate<ItemStack> spend) {
        var player = client.player;
        var footing = player.hasVehicle() ? MeleeRecovery.Footing.VEHICLE
            : player.isTouchingWater() ? MeleeRecovery.Footing.WET
            : player.isOnGround() && player.hurtTime == 0 && !player.isOnFire() ? MeleeRecovery.Footing.DRY
            : MeleeRecovery.Footing.UNSETTLED;
        Vec3d feet = player.getPos();
        double distance = visible == null ? Double.POSITIVE_INFINITY : player.squaredDistanceTo(visible);
        boolean closeMelee = !shoreSeparated && distance <= 5.0 * 5.0
            && (visible instanceof ZombieEntity || !(visible instanceof RangedAttackMob) && distance <= 3.4 * 3.4);
        boolean wounded = criticallyHurt(player) || healingMeal;
        boolean swimmerReceded = shoreSeparated && visible == meleeVisible;
        meleeVisible = closeMelee ? visible : null;
        var cue = ears.recentMeleeCue();
        meleeSound = cue;
        meleeImpulseLook = Float.NaN;
        // Damage without an identified source warrants defense, not permission to attack.
        // Burning and hunger loss alone must not suppress their own recovery.
        boolean hit = healthLost > 0 && !player.isOnFire()
            && (player.getHungerManager().getFoodLevel() > 0 || closeMelee || cue != null && player.hurtTime > 0);
        meleeFreshHit = hit;
        int weapon = (closeMelee || visible instanceof ZombieEntity || melee.active || hit)
                && !client.options.attackKey.isUnbound()
            ? bestWeapon(PlayerInventory.HOTBAR_SIZE, true, spend) : -1;
        boolean close = closeMelee && (wounded || meleeOutmatched(weapon, spend));
        double movedX = meleeStart == null ? 0 : feet.x - meleeStart.x;
        double movedZ = meleeStart == null ? 0 : feet.z - meleeStart.z;
        boolean separated = swimmerReceded && !hit && !melee.pinned
            || meleeDrove && movedX * movedX + movedZ * movedZ >= 5 * 5
            && distance >= 6 * 6 && body.hasRecentView() && footing == MeleeRecovery.Footing.DRY;
        boolean started = !melee.active;
        boolean wasEscaping = meleeEscapeFirst;
        var evidence = close ? MeleeRecovery.Evidence.CONTACT
            : cue != null ? MeleeRecovery.Evidence.AMBIENT : MeleeRecovery.Evidence.NONE;
        boolean critical = player.getHealth() <= 4;
        boolean active = hit ? melee.observeImpact(tick, healthLost, critical, separated, footing)
            : melee.observe(tick, evidence, critical, separated, footing);
        meleeEscapeFirst = melee.escapeFirst(tick, player.getHealth(), weapon >= 0, weapon >= 0 && usableMeleeShield(spend))
            || wounded && meleeOutmatched(weapon, spend);
        if (!active) {
            meleeAttacker = null;
            stopMeleeWalk();
            melee.retreatStarted = false;
            meleeGrade = null;
            meleeGradeLook = null;
            return false;
        }
        if (started) {
            meleeStart = feet;
            meleeHeading = player.getYaw();
            meleeAway = Float.NaN;
            melee.finishLook();
            meleeDriveFrom = null;
            meleeDriveConfirmed = meleeDrove = false;
            resetMeleeSurvey(feet, tick);
        }
        if (closeMelee && (hit || melee.recentImpact(tick)) && body.visiblyCorroboratesMeleeImpact(visible)) {
            meleeAttacker = visible;
            meleeAttackerTick = tick;
        }
        float away = Float.NaN;
        if (closeMelee) {
            away = yaw(feet.subtract(visible.getPos()));
            melee.finishLook();
        } else if (hit || melee.recentImpact(tick)) {
            Vec3d impulse = player.getVelocity();
            if (player.hurtTime > 0 && impulse.y > 0.06 && impulse.horizontalLengthSquared() >= 0.0064) {
                away = yaw(impulse);
                meleeImpulseLook = away + 180;
            }
        }
        if (meleeEscapeFirst) {
            if (!wasEscaping || started) {
                stopMeleeWalk();
                melee.retreatStarted = false;
            }
            melee.orientRetreat(tick, away, player.getYaw(), body.recentEmergencyBearing(), closeMelee);
            meleeAway = melee.retreatAway;
            return true;
        }
        boolean facesVisibleThreat = closeMelee && turnDifference(away, meleeLane) >= 112;
        if (facesVisibleThreat || Float.isFinite(away) && !Float.isFinite(meleeLane)
                && (!Float.isFinite(meleeAway) || hit && turnDifference(away, meleeAway) >= 100)) {
            meleeAway = away;
            resetMeleeSurvey(feet, tick);
        }
        return true;
    }

    LivingEntity meleeAttacker(int tick) {
        return melee.active && tick - meleeAttackerTick < MeleeRecovery.QUIET_AFTER_HIT ? meleeAttacker : null;
    }
    boolean recentMeleeImpact(int tick) { return melee.recentImpact(tick); }

    boolean avoidMeleePursuit(LivingEntity threat) {
        // Outside the close encounter, let ordinary work resume rather than
        // walking back into the same hostile out of generic combat pursuit.
        return meleeEscapeFirst && threat instanceof ZombieEntity;
    }

    boolean retreatFromEnderman(LivingEntity threat, Predicate<ItemStack> spend) {
        return threat instanceof EndermanEntity && (body.threatPoint() == null || meleeOutmatched(spend));
    }

    private boolean meleeOutmatched(Predicate<ItemStack> spend) {
        return meleeOutmatched(bestWeapon(PlayerInventory.HOTBAR_SIZE, true, spend), spend);
    }

    private boolean meleeOutmatched(int weapon, Predicate<ItemStack> spend) {
        var player = client.player;
        if (weapon < 0) return true; // A shield without a weapon is still not a duel kit.
        ItemStack main = player.getMainHandStack(), offhand = player.getOffHandStack();
        if (SHIELD.test(offhand) && canWear(offhand, spend) || SHIELD.test(main) && canWear(main, spend)
                || player.getArmor() >= 4)
            return false;
        ItemStack stack = player.getInventory().getStack(weapon);
        return stack.isOf(Items.WOODEN_AXE) || stack.isOf(Items.WOODEN_SWORD) || player.getHealth() <= 10;
    }

    boolean meleeActive() { return melee.active; }
    boolean meleeNeedsShore() { return melee.needsShore(); }

    void meleeWaterStep(AgentWaterEscape.Result result, String shoreStatus, int tick, Predicate<ItemStack> spend) {
        markDanger(tick);
        forgetContact();
        body.prioritizeMovement();
        meleeDriveConfirmed = false;
        if (result == AgentWaterEscape.Result.LANDED || result == AgentWaterEscape.Result.INTERRUPTED) {
            boolean landed = result == AgentWaterEscape.Result.LANDED;
            melee.leaveShore(landed);
            meleeHeading = client.player.getYaw();
            meleeAway = Float.NaN;
            resetMeleeSurvey(client.player.getPos(), tick);
            if (landed) meleeStatus(shoreStatus);
        } else {
            if (result == AgentWaterEscape.Result.BLOCKED && client.player.getAir() >= AgentWaterEscape.MIN_WORK_AIR) {
                Vec3d contact = meleeContact();
                if (defendFromMelee(contact, tick, spend, false) || checkMeleeSound(tick)) return;
            }
            meleeStatus(shoreStatus);
        }
    }

    void meleeStep(int tick, Predicate<BlockState> dangerous, Predicate<ItemStack> spend) {
        markDanger(tick);
        forgetContact();
        body.pauseWork();
        body.prioritizeMovement();
        var player = client.player;
        meleeDriveConfirmed = false;
        if (player.isTouchingWater() || player.hasVehicle() || client.currentScreen != null) {
            meleeStatus("waiting for control of the view");
            return;
        }
        Vec3d feet = player.getPos();
        if (meleeDriveFrom != null && tick == meleeDriveTick + 1) {
            Vec3d change = feet.subtract(meleeDriveFrom);
            meleeDriveConfirmed = MeleeRecovery.checkedStride(body.appliedEmergencyDrive(), player.isOnGround(),
                meleeFreshHit || player.hurtTime != 0, change.dotProduct(Vec3d.fromPolar(0, meleeDriveYaw)),
                change.y, meleeMotionBefore);
            meleeDrove |= meleeDriveConfirmed;
        }
        boolean grounded = player.isOnGround();
        if (meleeEscapeFirst) {
            meleeDriveConfirmed = melee.retreat.sample(feet, grounded && !meleeFreshHit && player.hurtTime == 0
                && tick == meleeDriveTick + 1 && body.appliedEmergencyForward());
            meleeDrove |= meleeDriveConfirmed;
            retreatFromMelee(tick, spend);
            return;
        }
        boolean canMove = grounded && !meleeFreshHit;
        if (canMove && feet.squaredDistanceTo(meleeSurveyFrom) >= 1.4 * 1.4) {
            float continuing = meleeLane;
            resetMeleeSurvey(feet, tick);
            meleeLane = continuing;
        }
        float facing = player.getYaw(), bearing = Float.NaN;
        Vec3d landing = null;
        boolean aligned = false;
        if (canMove && (meleeTurn < MELEE_ESCAPE_TURNS.length || Float.isFinite(meleeLane))) {
            float knownYaw = body.recentEmergencyBearing();
            boolean knownRetreat = Float.isFinite(knownYaw)
                && (!Float.isFinite(meleeAway) || turnDifference(knownYaw, meleeAway) <= 92);
            float anchor = Float.isFinite(meleeAway) ? meleeAway : meleeHeading;
            bearing = Float.isFinite(meleeLane) ? meleeLane
                : knownRetreat && meleeTurn == 0 ? knownYaw
                : anchor + MELEE_ESCAPE_TURNS[meleeTurn];
            aligned = canMove && turnDifference(facing, bearing) <= 6 && Math.abs(player.getPitch() - meleeLookPitch) <= 11
                && body.renderedDirection(bearing, meleeLookPitch, 12);
            if (aligned) {
                landing = meleeLane(feet, Vec3d.fromPolar(0, facing), facing, player.getWidth() * 0.5 + 0.055, dangerous);
            }
        }
        Vec3d contact = landing == null ? meleeContact() : null;
        var action = MeleeRecovery.dryAction(grounded, meleeFreshHit, landing != null, contact != null,
            false, meleeTurn >= MELEE_ESCAPE_TURNS.length);
        if (action == MeleeRecovery.DryAction.RETREAT) {
            meleeLane = bearing;
            meleeSamples = 0;
            measureMeleeDrive(feet, tick, facing);
            double shown = Math.sqrt(feet.squaredDistanceTo(landing));
            double speed = Math.sqrt(player.getVelocity().horizontalLengthSquared());
            boolean sprint = !client.options.sprintKey.isUnbound()
                && MeleeRecovery.canSprint(shown, speed, player.getHungerManager().getFoodLevel(), player.isSprinting());
            body.driveEmergencyLane(landing, facing, meleeLookPitch, sprint);
            meleeStatus(meleeDriveConfirmed ? "confirmed voluntary retreat on a witnessed dry lane"
                : sprint ? "requesting sprint away on a witnessed dry lane" : "requesting retreat on a witnessed dry lane");
            return;
        }
        if (action == MeleeRecovery.DryAction.COUNTER) {
            if (defendFromMelee(contact, tick, spend, true)) {
                meleeTurnSince = tick;
                return;
            }
            action = canMove ? MeleeRecovery.DryAction.SURVEY : MeleeRecovery.DryAction.WAIT;
        }
        if (checkMeleeSound(tick)) return;
        if (action == MeleeRecovery.DryAction.WAIT) {
            meleeStatus("waiting for grounded dry footing before moving");
        } else if (Float.isFinite(bearing)) {
            body.turnUrgent(bearing, meleeLookPitch);
            if (aligned) {
                if (++meleeSamples >= 2) nextMeleeView(tick);
                meleeStatus("checking dry retreat footing; " + meleeRefusal);
            } else {
                if (tick - meleeTurnSince >= 30 && body.hasRecentView()) nextMeleeView(tick);
                meleeStatus(body.hasRecentView() ? "aligning the retreat view" : "waiting for a rendered retreat view");
            }
        } else {
            body.sneak();
            meleeStatus("no safe dry retreat witnessed"
                + (meleeVisible == null ? "; no hostile in the current view" : contact == null ? "; hostile out of reach"
                    : "; no usable held defense against the visible hostile")
                + (meleeRefusal == null ? "" : "; " + meleeRefusal));
        }
    }

    private void measureMeleeDrive(Vec3d feet, int tick, float bearing) {
        meleeDriveFrom = feet;
        meleeDriveTick = tick;
        meleeDriveYaw = bearing;
        meleeMotionBefore = client.player.getVelocity().dotProduct(Vec3d.fromPolar(0, bearing));
    }

    private void stopMeleeWalk() {
        if (melee.retreat.travel != null) body.stopHorizonTravel(melee.retreat.travel);
        melee.retreat.travel = null;
    }

    private void retreatFromMelee(int tick, Predicate<ItemStack> spend) {
        var player = client.player;
        Vec3d feet = player.getPos();
        if (meleeGrade != null && stepMeleeGrade(tick)) return;
        if (meleeGradeLook != null && lookAtMeleeGrade(tick)) return;
        var retreat = melee.retreat;
        if (retreat.exhausted && feet.squaredDistanceTo(meleeSurveyFrom) >= 0.64) {
            meleeSurveyFrom = feet;
            stopMeleeWalk();
            retreat.start(tick, meleeAway, player.getYaw());
        }
        // A knockback invalidates the old motion receipt, not the intended exit.
        // Recreate its observation at these actual feet without choosing a new bearing.
        if (meleeFreshHit) stopMeleeWalk();
        if (!retreat.exhausted) {
            var walk = melee.escapeWalk(feet);
            var result = body.driveHorizon(walk, false, false);
            if (result == AgentBody.HorizonResult.MOVING) {
                meleeDriveTick = tick;
                meleeStatus(meleeDriveConfirmed ? "continuing a voluntary retreat on witnessed dry footing"
                    : "requesting a rolling dry retreat with sprint where the witnessed runway permits");
                return;
            }
            boolean aligned = body.renderedDirection(retreat.bearing(), walk.gazePitch(), 12);
            if (player.isOnGround() && !meleeFreshHit && aligned && offerMeleeGrade(tick, feet)) return;
            if (result == AgentBody.HorizonResult.ARRIVED || result == AgentBody.HorizonResult.BLOCKED
                    && player.isOnGround() && !meleeFreshHit && (aligned || tick - retreat.aimedAt >= 35)) {
                stopMeleeWalk();
                retreat.next(tick);
            }
            // Recheck an actual past tread while the forward view is unavailable.
            if (player.isOnGround() && !meleeFreshHit) {
                float tread = body.stepRecentEmergencyTread(meleeAway);
                if (Float.isFinite(tread)) {
                    measureMeleeDrive(feet, tick, tread);
                    meleeStatus("creating space across a rechecked past tread while looking for the exit");
                    return;
                }
            }
            meleeStatus("checking a rolling dry exit: " + body.rangedFootingRefusal());
            return;
        }
        // Only a blocked escape gives the attacker the camera. Sound and our
        // own impulse select a look, never a target or permission to strike.
        Vec3d contact = meleeContact();
        if (contact != null && defendFromMelee(contact, tick, spend, true)) return;
        if (checkMeleeSound(tick)) return;
        if (Float.isFinite(meleeAway)) body.turnUrgent(meleeAway + 180, ZOMBIE_LOOK_PITCH);
        meleeStatus("blocked dry escape; looking for a visible reachable attacker before defending");
    }

    private boolean offerMeleeGrade(int tick, Vec3d feet) {
        var grade = body.ordinaryGrade(feet.add(Vec3d.fromPolar(0, melee.retreat.bearing()).multiply(2)));
        if (grade == null) return false;
        stopMeleeWalk();
        if (grade.lookOnly()) {
            meleeGradeLook = grade;
            meleeGradeLookBy = tick + 12;
            return lookAtMeleeGrade(tick);
        }
        meleeGrade = AgentSurfaceTread.ordinaryGrade(grade.edge(), grade.from(), tick);
        return stepMeleeGrade(tick);
    }

    private boolean lookAtMeleeGrade(int tick) {
        var cue = meleeGradeLook;
        if (tick < meleeGradeLookBy && cue.from().equals(client.player.getBlockPos())) {
            if (body.renderedFrame() <= cue.frame() || !body.renderedAim(cue.topAim(), 8)) {
                body.aimUrgent(cue.topAim());
                meleeStatus("checking the exact top of a witnessed adjacent escape tread");
                return true;
            }
            var proved = body.ordinaryGradeAfterLook(cue);
            if (proved != null) meleeGrade = AgentSurfaceTread.ordinaryGrade(proved.edge(), proved.from(), tick);
        }
        meleeGradeLook = null;
        return meleeGrade != null && stepMeleeGrade(tick);
    }

    private boolean stepMeleeGrade(int tick) {
        switch (meleeGrade.step(client, body, tick)) {
            case CHECKING, MOVING -> meleeStatus("retreating across a witnessed one-block dry tread");
            case LANDED -> {
                meleeGrade = null;
                stopMeleeWalk();
                melee.retreat.sector = 0;
                melee.retreat.exhausted = false;
                meleeStatus("landed on the witnessed dry tread; continuing the retreat");
            }
            case REFUSED -> {
                meleeGrade = null;
                stopMeleeWalk();
                melee.retreat.next(tick);
                return false;
            }
        }
        return true;
    }

    private void meleeStatus(String action) {
        status = (meleeFreshHit ? "melee emergency (fresh damage): " : "melee emergency: ") + action;
    }

    boolean confirmedMeleeRetreat() { return meleeDriveConfirmed; }

    private boolean checkMeleeSound(int tick) {
        if (meleeVisible != null) return false;
        // A sound or our own knockback supplies a bearing, not a target.
        float bearing = melee.lookBearing(tick, meleeSound, meleeImpulseLook);
        if (!Float.isFinite(bearing)) return false;
        meleeTurnSince = tick;
        if (body.renderedDirection(bearing, ZOMBIE_LOOK_PITCH, 12)) {
            melee.finishLook();
            return false;
        }
        body.turnUrgent(bearing, ZOMBIE_LOOK_PITCH);
        meleeStatus("reorienting from a nearby sound or hit impulse; hostile not confirmed");
        return true;
    }

    private Vec3d meleeContact() {
        return meleeVisible != null && body.hasRecentView() && client.player.canInteractWithEntity(meleeVisible, 0)
            ? body.threatPoint() : null;
    }

    private boolean defendFromMelee(Vec3d contact, int tick, Predicate<ItemStack> spend, boolean allowShield) {
        if (contact == null) return false;
        var player = client.player;
        ItemStack main = player.getMainHandStack();
        boolean attackBound = !client.options.attackKey.isUnbound();
        boolean readyTool = (main.isIn(ItemTags.SWORDS) || main.isIn(ItemTags.AXES) || main.isIn(ItemTags.PICKAXES))
            && canWear(main, spend);
        if (attackBound && !readyTool) {
            int weapon = meleeToolSlot(spend);
            if (weapon >= 0) {
                body.aimUrgent(contact);
                selectRangedSlot(weapon, tick);
                meleeStatus("selecting a carried weapon while facing a visible hostile");
                return true;
            }
        }
        boolean canStrike = attackBound && canWear(main, spend);
        if (canStrike && player.getAttackCooldownProgress(0.5f) >= 0.9f && body.renderedMeleeStrike(meleeVisible)) {
            body.aimUrgent(contact);
            // Vanilla consumes the use release before it accepts a new attack edge.
            if (player.isUsingItem()) {
                meleeStatus("releasing item use for a defensive strike");
            } else {
                body.strike(meleeVisible);
                if (meleeEscapeFirst) {
                    // A defensive attack request is not a kill or separation
                    // receipt. Try to create space again on the next dry turn.
                    stopMeleeWalk();
                    melee.retreat.start(tick, meleeAway, player.getYaw());
                    meleeSurveyFrom = player.getPos();
                }
                meleeStatus("requesting a charged defensive strike at a confirmed hostile under the crosshair");
            }
            return true;
        }
        if (allowShield && guardMeleeContact(contact, spend)) return true;
        if (!canStrike) return false;
        body.aimUrgent(contact);
        meleeStatus("aiming at a visible hostile for a charged defensive strike");
        return true;
    }

    private boolean usableMeleeShield(Predicate<ItemStack> spend) {
        var player = client.player;
        ItemStack main = player.getMainHandStack();
        ItemStack shield = SHIELD.test(main) ? main : player.getOffHandStack();
        return !client.options.useKey.isUnbound() && SHIELD.test(shield) && canWear(shield, spend)
            && !player.getItemCooldownManager().isCoolingDown(shield) && AgentBody.shieldSafeMainHand(main)
            && !(main.isIn(ItemTags.AXES) && body.shieldStartWouldUseBlock());
    }

    private boolean guardMeleeContact(Vec3d contact, Predicate<ItemStack> spend) {
        if (!usableMeleeShield(spend)) return false;
        var player = client.player;
        body.sneak();
        body.aimUrgent(contact);
        body.blockAgainst(meleeVisible);
        meleeStatus(player.isBlocking() && SHIELD.test(player.getActiveItem())
            ? "shield raised against a visible melee threat" : "raising a held shield toward a visible melee threat");
        return true;
    }

    private int meleeToolSlot(Predicate<ItemStack> spend) {
        int weapon = bestWeapon(PlayerInventory.HOTBAR_SIZE, true, spend);
        if (weapon >= 0) return weapon;
        var inventory = client.player.getInventory();
        for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
            if (client.options.hotbarKeys[slot].isUnbound()) continue;
            ItemStack stack = inventory.getStack(slot);
            if (stack.isIn(ItemTags.PICKAXES) && canWear(stack, spend)) return slot;
        }
        return -1;
    }

    private Vec3d meleeLane(Vec3d feet, Vec3d lane, float bearing, double width, Predicate<BlockState> dangerous) {
        Vec3d end = null;
        double witnessed = 0;
        Direction travel = Direction.fromHorizontalDegrees(bearing);
        double speed = Math.sqrt(client.player.getVelocity().horizontalLengthSquared());
        for (double distance : MELEE_FLOOR_ROWS) {
            Vec3d row = feet.add(lane.x * distance, 0, lane.z * distance);
            String refused = meleeRow(row, lane, bearing, distance, width, travel, dangerous);
            if (refused != null) {
                meleeRefusal = "row " + distance + " " + refused;
                break;
            }
            end = row;
            witnessed = distance;
        }
        if (witnessed >= Math.max(0.42, speed * 2.65 + 0.14)) return end;
        if (end != null) meleeRefusal = "proved floor, but too little braking distance";
        return null;
    }

    private String meleeRow(Vec3d row, Vec3d lane, float bearing, double distance, double width,
                            Direction travel, Predicate<BlockState> dangerous) {
        if (body.hazardAhead(bearing, distance + 0.22)) return "known hazard";
        Vec3d below = row.add(0, -0.035, 0);
        var center = body.emergencyFloor(below, travel, dangerous);
        if (center != AgentBody.DryRouteTop.WITNESSED) return "center " + center;
        var right = body.emergencyFloor(below.add(width * lane.z, 0, -width * lane.x), travel, dangerous);
        if (right != AgentBody.DryRouteTop.WITNESSED) return "right " + right;
        var left = body.emergencyFloor(below.add(-width * lane.z, 0, width * lane.x), travel, dangerous);
        if (left != AgentBody.DryRouteTop.WITNESSED) return "left " + left;
        Vec3d clearance = row.add(0, 0.55, 0);
        if (!body.overlandClear(clearance, dangerous)) {
            var refusal = body.dryRouteClear(clearance);
            return refusal == AgentBody.DryRouteSample.CLEAR ? "hazard in clearance" : "clearance " + refusal;
        }
        if (distance >= 1.25 && (!body.overlandClear(clearance.add(width * lane.z, 0, -width * lane.x), dangerous)
                || !body.overlandClear(clearance.add(-width * lane.z, 0, width * lane.x), dangerous)))
            return "side clearance not witnessed";
        if (!body.emergencyLaneClear(row, width)) return "collision veto";
        return null;
    }

    private void nextMeleeView(int tick) {
        meleeSamples = 0;
        meleeTurnSince = tick;
        if (meleeLookPitch < 50) {
            meleeLookPitch = 57;
            return;
        }
        meleeLookPitch = 44;
        meleeLane = Float.NaN;
        meleeTurn++;
    }

    private void resetMeleeSurvey(Vec3d feet, int tick) {
        meleeSurveyFrom = feet;
        meleeLane = Float.NaN;
        meleeTurn = 0;
        meleeTurnSince = tick;
        meleeLookPitch = 44;
        meleeSamples = 0;
        meleeRefusal = null;
    }

    private static float turnDifference(float a, float b) {
        return Math.abs(MathHelper.wrapDegrees(a - b));
    }

    /** Track actual damage, not the number of shots or the number of requested keys. */
    static final class RangedFire {
        private static final int DAMAGE_WINDOW = 100;
        private int lastHit = -DAMAGE_WINDOW;
        private float from = Float.NaN;
        private boolean repeated;

        boolean hit(int tick, float toward) {
            repeated = tick - lastHit < DAMAGE_WINDOW && turnDifference(toward, from) <= 50;
            if (!repeated) from = toward;
            lastHit = tick;
            return repeated;
        }

        boolean repeated(int tick) { return repeated && tick - lastHit < DAMAGE_WINDOW; }
        float away() { return MathHelper.wrapDegrees(from + 180); }
        void reset() {
            lastHit = -DAMAGE_WINDOW;
            from = Float.NaN;
            repeated = false;
        }
    }

    /** Losing sight while turning away is not a quiet interval after an impact. */
    static final class RangedEpisode {
        private static final int SHOT_TO_HIT_TICKS = 18, COVER_TICKS = 34, SEPARATED_TICKS = 50;
        private int evidenceAt, coveredSince = -1, heardAt = -SHOT_TO_HIT_TICKS - 1;
        private int pressureAt, lastHit = -1;
        private boolean active, hit;

        boolean observe(int tick, boolean archerSeen, boolean shot, boolean damaged, boolean behindCover,
                        boolean injured, boolean separated) {
            if (shot) heardAt = tick;
            hit = damaged && (archerSeen || active || heardRecently(tick));
            if (hit) lastHit = tick;
            if (archerSeen || hit) evidenceAt = pressureAt = tick;
            // A matching shot can extend confirmed pressure, but ambient fire alone cannot
            // claim movement or keep it forever when there is no new sighting or impact.
            if (active && shot && tick - evidenceAt < 200) pressureAt = tick;
            if (!behindCover || archerSeen || hit || !active) coveredSince = -1;
            else if (coveredSince < 0) coveredSince = tick;
            int quiet = lastHit < 0 ? 75 : injured ? 200 : 145;
            int sincePressure = tick - pressureAt;
            boolean covered = coveredSince >= 0 && tick - coveredSince >= COVER_TICKS && sincePressure >= COVER_TICKS;
            active = archerSeen || hit || active && !covered
                && !(separated && sincePressure >= SEPARATED_TICKS)
                && (tick - evidenceAt < quiet || sincePressure < 75 && tick - evidenceAt < 260);
            if (!active) lastHit = -1;
            return active;
        }

        private boolean heardRecently(int tick) { return tick - heardAt <= SHOT_TO_HIT_TICKS; }

        void reset() {
            active = hit = false;
            heardAt = -SHOT_TO_HIT_TICKS - 1;
            coveredSince = lastHit = -1;
        }
    }

    /** One intended direction across many independently proved dry windows, not a string of dodge endpoints. */
    static final class RangedRetreat {
        private static final float[] TURNS = {0, 36, 68, 90, -36, -68, -90};
        private float away, surveyBearing, bearing, side;
        private int sector, aimedAt;
        private Vec3d lastFeet, riskFrom;
        private AgentBody.HorizonTravel travel;
        private double progress;
        private boolean exhausted;

        void reset() {
            away = Float.NaN;
            lastFeet = riskFrom = null;
            travel = null;
            progress = 0;
            sector = aimedAt = 0;
            exhausted = false;
        }

        void start(int tick, float away, float now) {
            this.away = away;
            float initial = Float.isFinite(away) ? away : now;
            surveyBearing = initial;
            side = MathHelper.wrapDegrees(now - initial) < 0 ? -1 : 1;
            sector = 0;
            exhausted = false;
            setBearing(tick, turnDifference(initial, now) <= 48 ? now : initial);
        }

        void prefer(int tick, float towardCover) {
            if (!Float.isFinite(away) || turnDifference(away, towardCover) <= 100) {
                exhausted = false;
                setBearing(tick, towardCover);
            }
        }

        void next(int tick) {
            while (sector < TURNS.length) {
                float candidate = surveyBearing + side * TURNS[sector++];
                if (turnDifference(candidate, bearing) > 18) {
                    setBearing(tick, candidate);
                    return;
                }
            }
            exhausted = true;
        }

        private void setBearing(int tick, float requested) {
            bearing = MathHelper.wrapDegrees(requested);
            aimedAt = tick;
            travel = null;
        }

        void riskAt(Vec3d feet) {
            riskFrom = feet;
            progress = 0;
        }

        boolean sample(Vec3d feet, boolean applied) {
            Vec3d from = lastFeet;
            lastFeet = feet;
            if (!applied || from == null || Math.abs(feet.y - from.y) > 0.055
                    || feet.squaredDistanceTo(from) > 0.31) return false;
            if (Float.isFinite(away))
                progress = Math.max(0, progress + projected(from, feet, away));
            return projected(from, feet, bearing) >= 0.025;
        }

        private static double projected(Vec3d from, Vec3d feet, float heading) {
            double radians = Math.toRadians(heading);
            return -(feet.x - from.x) * Math.sin(radians) + (feet.z - from.z) * Math.cos(radians);
        }

        boolean separated(Vec3d feet) {
            return riskFrom != null && Float.isFinite(away) && progress >= 10
                && projected(riskFrom, feet, away) >= 10;
        }

        AgentBody.HorizonTravel walk(Vec3d feet, Vec3d cover) {
            if (travel == null || cover == null && feet.squaredDistanceTo(travel.goal) < 9) {
                Vec3d goal = cover != null ? cover : feet.add(Vec3d.fromPolar(0, bearing).multiply(24));
                travel = AgentBody.HorizonTravel.rangedRetreat(goal, away, cover == null);
            }
            return travel;
        }

        float bearing() { return bearing; }
    }

    boolean rangedActive() {
        return rangedEpisode.active || rangedUntil != 0 && System.nanoTime() - rangedUntil < 0;
    }

    boolean ordinaryRangedActive() { return rangedEpisode.active; }

    boolean observeOrdinaryRanged(AgentEars ears, LivingEntity nearest, boolean hurt, int tick) {
        var player = client.player;
        var cue = ears.takeFreshRangedCue();
        if (cue != null) {
            lastShotYaw = cue.yaw();
            lastShotPitch = cue.pitch();
        }
        Vec3d seen = body.rangedThreatPoint();
        if (seen == null && holdsTrident(nearest)) seen = body.threatPoint();
        boolean wasActive = rangedEpisode.active;
        boolean meleeHit = nearest != null && !(nearest instanceof RangedAttackMob)
            && body.visiblyCorroboratesMeleeImpact(nearest);
        if (meleeHit) {
            // The previous ranged owner cannot swallow a newly corroborated
            // close impact and pass zero damage to melee recovery.
            resetOrdinaryRanged();
            rangedUntil = 0;
            return false;
        }
        rangedHitNow = hurt && !player.isOnFire() && !player.isTouchingWater() && !meleeHit;
        sheltered = wasActive && seen == null && !rangedHitNow && player.isOnGround() && !player.isTouchingWater()
            && holdsShelter(player.getPos());
        boolean settled = sheltered && player.getVelocity().horizontalLengthSquared() <= 0.0025;
        Vec3d feet = player.getPos();
        rangedRetreatReceipt = wasActive && rangedRetreat.sample(feet, !hurt && player.isOnGround()
            && !player.isTouchingWater() && tick == rangedDriveTick + 1 && body.appliedEmergencyForward());
        boolean supportingShot = cue != null && (!wasActive || rangedHitNow || !Float.isFinite(rangedYaw)
            || turnDifference(cue.yaw(), rangedYaw) <= 45);
        if (!rangedEpisode.observe(tick, seen != null, supportingShot, rangedHitNow, settled,
                player.getHealth() <= 10, rangedRetreat.separated(feet))) {
            if (wasActive) clearOrdinaryRanged();
            return false;
        }
        if (!wasActive) {
            rangedCoverTried = false;
            rangedFootingRefusal = "no lane checked";
            rangedWallRefusal = "no supported wall yet";
            shelterScanAfter = tick;
            rangedSurveyFrom = null;
            rangedYaw = Float.NaN;
            rangedPitch = 10;
            rangedRetreat.sample(feet, false);
        }
        float previous = rangedYaw;
        if (seen != null) {
            rangedSource = seen;
            rangedSightAt = tick;
            aimRangedDirection(seen.subtract(player.getEyePos()));
        } else if (rangedEpisode.hit) {
            // A new impact contradicts cover of the old line. Audio and physical knockback
            // can nominate a retreat bearing, never an entity or a point for building cover.
            if (holdsShelter(player.getPos())) {
                rangedSource = null;
                clearShelter();
            }
            if (rangedEpisode.heardRecently(tick) && (rangedSource == null || turnDifference(rangedYaw, lastShotYaw) > 55)) {
                rangedSource = null;
                clearShelter();
                rangedYaw = lastShotYaw;
                rangedPitch = lastShotPitch;
            } else if (rangedSource == null && !Float.isFinite(rangedYaw) && player.hurtTime >= 8
                    && player.getVelocity().y > 0.06 && player.getVelocity().horizontalLengthSquared() > 0.0064) {
                rangedYaw = MathHelper.wrapDegrees(yaw(player.getVelocity()) + 180);
            }
        }
        if (seen != null || rangedEpisode.hit) rangedRetreat.riskAt(feet);
        if (rangedEpisode.hit) {
            stopRangedWalk();
            rangedWall = null;
            rangedGrade = null;
            rangedGradeLook = null;
        }
        boolean changedLine = Float.isFinite(rangedYaw)
            && (!Float.isFinite(previous) || turnDifference(previous, rangedYaw) > 55);
        if (rangedSurveyFrom != null && (changedLine
                || seen != null && turnDifference(rangedRetreat.bearing(), rangedYaw) < 65)) {
            stopRangedWalk();
            rangedSurveyFrom = null;
        }
        return true;
    }

    private void aimRangedDirection(Vec3d direction) {
        rangedYaw = yaw(direction);
        rangedPitch = (float) Math.toDegrees(Math.atan2(-direction.y, direction.horizontalLength()));
    }

    void resetOrdinaryRanged() {
        if (rangedEpisode.active) clearOrdinaryRanged();
        rangedEpisode.reset();
    }

    void afterRespawn() {
        stopMeleeWalk();
        resetOrdinaryRanged();
        rangedUntil = 0;
        rangedAudible = rangedUnderFire = rangedCoverTried = false;
        coverReceipt = rangedRetreatReceipt = rangedHitNow = false;
        rangedFire.reset();
        rangedRetreat.reset();
        rangedFootworkStarted = false;
        rangedBlockedAt = null;
        rangedCover = null;
        rangedYaw = rangedPitch = Float.NaN;
        melee.reset();
        meleeStart = meleeSurveyFrom = meleeDriveFrom = null;
        meleeVisible = meleeAttacker = lastThreat = null;
        meleeSound = null;
        meleeAway = meleeLane = meleeImpulseLook = Float.NaN;
        meleeGrade = null;
        meleeGradeLook = null;
        meleeFreshHit = meleeEscapeFirst = meleeDriveConfirmed = meleeDrove = false;
        meleeDriveTick = -1;
        engagementStarted = lastEngaged = seenAt = calmAfter = 0;
        aim = null;
        cancelSelection();
        stopZombieLook();
        zombieLookUntil = 0;
        zombieLookAfter = zombieLookAligned = 0;
    }

    private void clearOrdinaryRanged() {
        stopRangedWalk();
        clearShelter();
        rangedSource = rangedSurveyFrom = null;
        rangedGrade = null;
        rangedGradeLook = null;
        rangedWall = null;
        rangedCover = null;
        rangedDriveTick = -1;
        sheltered = false;
    }

    boolean observeRanged(AgentEars ears, LivingEntity visible, boolean hurt, int tick) {
        rangedHitNow = hurt && !client.player.isOnFire();
        var cue = ears.takeFreshRangedCue();
        boolean active = rangedActive();
        Vec3d seen = holdsTrident(visible) || hurt && visible instanceof RangedAttackMob
                && (visible.isHolding(Items.BOW) || visible.isHolding(Items.CROSSBOW)) ? body.threatPoint() : null;
        if (cue == null && seen == null) {
            if (active && hurt) {
                rangedUnderFire = true;
                recordRangedImpact(tick);
            }
            return active;
        }
        if (!active) {
            rangedAudible = cue != null;
            rangedUnderFire = hurt;
            rangedCoverTried = false;
            rangedCover = null;
        } else {
            rangedUnderFire |= hurt || cue != null
                && Math.abs(MathHelper.wrapDegrees(cue.yaw() - rangedYaw)) <= 45;
        }
        if (seen != null) {
            Vec3d direction = seen.subtract(client.player.getEyePos());
            rangedYaw = yaw(direction);
            rangedPitch = (float) Math.toDegrees(Math.atan2(-direction.y, direction.horizontalLength()));
        } else if (cue != null && (!active || hurt || Math.abs(MathHelper.wrapDegrees(cue.yaw() - rangedYaw)) <= 45)) {
            rangedYaw = cue.yaw();
            rangedPitch = cue.pitch();
        } else {
            // An opposing audio cue alone does not spin the player or pin this alert.
            return active;
        }
        recordRangedImpact(tick);
        rangedUntil = System.nanoTime() + RANGED_ALERT_NANOS;
        return true;
    }

    private void recordRangedImpact(int tick) {
        if (rangedHitNow && !rangedFire.hit(tick, rangedYaw)) {
            rangedFootworkStarted = false;
            rangedBlockedAt = null;
        }
    }

    void rangedStep(int tick, Predicate<BlockPos> protectsRoute, Predicate<ItemStack> spend) {
        boolean ordinary = rangedEpisode.active;
        coverReceipt = false;
        if (!ordinary) rangedRetreatReceipt = false;
        markDanger(tick);
        forgetContact();
        body.prioritizeMovement();
        var player = client.player;
        status = ordinary ? "withdrawing from ranged danger"
            : rangedAudible ? "responding to a nearby skeleton shot" : "responding to a visible archer";
        // The fall controller has already had priority. Never add a movement key to the impulse.
        if (ordinary && (rangedEpisode.hit || player.hurtTime >= 8
                || player.hurtTime > 0 && player.getVelocity().y > 0.06)) {
            body.pauseWork();
            body.prioritizeMovement();
            status = "ranged danger; letting the hit impulse settle";
            return;
        }
        if (ordinary && rangedGrade != null && !player.isTouchingWater() && !player.hasVehicle()
                && client.currentScreen == null && stepRangedGrade(tick)) return;
        if (!player.isOnGround() || player.isTouchingWater() || player.hasVehicle() || client.currentScreen != null) {
            if (ordinary) body.pauseWork();
            status = "ranged threat; waiting for grounded dry footing";
            return;
        }
        if (ordinary && sheltered) {
            body.pauseWork();
            body.sneak();
            status = "holding solid cover across the last witnessed shot line";
            return;
        }
        if (!ordinary) aimRangedGuard();
        ItemStack main = player.getMainHandStack();
        boolean useBound = !client.options.useKey.isUnbound();
        ItemStack off = player.getOffHandStack();
        boolean offhand = useBound && SHIELD.test(off) && canWear(off, spend)
            && (!ordinary || !player.getItemCooldownManager().isCoolingDown(off));
        boolean mainGuard = useBound && SHIELD.test(main) && canWear(main, spend)
            && (!ordinary || !player.getItemCooldownManager().isCoolingDown(main));
        if ((!ordinary || Float.isFinite(rangedYaw)) && (mainGuard || offhand && AgentBody.shieldSafeMainHand(main)
                && !(main.isIn(ItemTags.AXES) && body.shieldStartWouldUseBlock()))) {
            if (ordinary) aimRangedGuard();
            body.guardRangedBearing(rangedYaw);
            if (player.isBlocking() && SHIELD.test(player.getActiveItem())) status = "blocking toward ranged fire";
            return;
        }
        if (player.isUsingItem()) return;
        var inventory = player.getInventory();
        int safeHand = -1, coverSlot = -1;
        for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
            if (slot != inventory.selectedSlot && client.options.hotbarKeys[slot].isUnbound()) continue;
            ItemStack stack = inventory.getStack(slot);
            if (useBound && SHIELD.test(stack)) {
                if (canWear(stack, spend) && (!ordinary || !player.getItemCooldownManager().isCoolingDown(stack))) {
                    safeHand = slot;
                    break;
                }
            }
            if (offhand && safeHand < 0 && (stack.isEmpty() || stack.isIn(ItemTags.SWORDS)
                    || stack.isIn(ItemTags.PICKAXES))) safeHand = slot;
            if (coverMaterial(stack) && (!ordinary || stack.getCount() >= (rangedWall != null && rangedWall.base != null ? 1 : 2))) {
                if ((spend == null || spend.test(stack)) && (coverSlot < 0 || slot == inventory.selectedSlot))
                    coverSlot = slot;
            }
        }
        if (safeHand >= 0 && (!ordinary || Float.isFinite(rangedYaw))) {
            selectRangedSlot(safeHand, tick);
            return;
        }
        if (ordinary) {
            retreatFromRangedFire(tick, useBound ? coverSlot : -1, protectsRoute, spend);
            return;
        }
        if (!offhand && rangedUnderFire && (useBound || rangedCover != null)
                && tryRangedCover(tick, coverSlot, protectsRoute, spend)) return;
        if (rangedFire.repeated(tick)) {
            evadeRangedFire(tick);
            return;
        }
        status = "ranged threat; no usable shield or cover";
    }

    private void aimRangedGuard() {
        body.sneak();
        body.turnUrgent(rangedYaw, MathHelper.clamp(rangedPitch, -55, 65));
    }

    private void retreatFromRangedFire(int tick, int coverSlot, Predicate<BlockPos> protectsRoute,
                                       Predicate<ItemStack> spend) {
        var player = client.player;
        Vec3d feet = player.getPos();
        float away = Float.isFinite(rangedYaw) ? MathHelper.wrapDegrees(rangedYaw + 180) : Float.NaN;
        if (shelter != null && (body.rangedCoverState(shelter) != shelterState
                || shelterUpper != null && body.rangedCoverState(shelter.up()) != shelterUpper
                || shelterGoal != null && (tick >= shelterUntil || feet.squaredDistanceTo(shelterGoal) > 5 * 5))) {
            clearShelter();
            advanceRangedSurvey(tick);
        }
        if (rangedSurveyFrom == null) {
            rangedSurveyFrom = feet;
            rangedRetreat.start(tick, away, player.getYaw());
            preferRangedShelter(tick, feet);
        }
        if (shelter == null && rangedSource != null && tick >= shelterScanAfter && body.hasRecentView()) {
            shelterScanAfter = tick + 4;
            boolean archerVisible = body.rangedThreatPoint() != null;
            var found = body.visibleRangedCover(pos -> {
                Vec3d goal = shelterDestination(pos, feet, rangedSource);
                return goal != null && (!archerVisible || goal != feet);
            });
            if (found != null) {
                shelter = found.getBlockPos();
                shelterState = body.rangedCoverState(shelter);
                shelterGoal = shelterDestination(shelter, feet, rangedSource);
                shelterUntil = tick + 50;
                rangedWall = null;
                if (body.rangedThreatPoint() == null && holdsShelter(feet)) {
                    body.pauseWork();
                    status = "holding solid cover across the last witnessed shot line";
                    return;
                }
                preferRangedShelter(tick, feet);
            }
        }
        if (rangedWall != null && tryRangedWall(tick, coverSlot, protectsRoute, spend)) return;
        if (rangedGradeLook != null && lookAtRangedGrade(tick)) return;
        if (rangedRetreat.exhausted && feet.squaredDistanceTo(rangedSurveyFrom) >= 0.64) {
            rangedSurveyFrom = feet;
            rangedRetreat.start(tick, away, player.getYaw());
            rangedCoverTried = false;
        }
        if (rangedRetreat.exhausted) {
            if (tryRangedWall(tick, coverSlot, protectsRoute, spend)) return;
            body.pauseWork();
            body.sneak();
            status = "ranged danger; no dry exit: " + rangedFootingRefusal + "; " + rangedWallRefusal;
            return;
        }
        var walk = rangedRetreat.walk(feet, shelterGoal);
        var result = body.driveHorizon(walk, false, false);
        if (result == AgentBody.HorizonResult.MOVING) {
            rangedDriveTick = tick;
            if (shelterGoal == null && feet.squaredDistanceTo(rangedSurveyFrom) >= 2.56) {
                rangedSurveyFrom = feet;
                rangedRetreat.sector = 0;
                rangedCoverTried = false;
            }
            status = rangedMovementStatus(shelterGoal != null);
            return;
        }
        rangedFootingRefusal = body.rangedFootingRefusal();
        boolean aligned = body.renderedDirection(rangedRetreat.bearing(), walk.gazePitch(), 12);
        if (aligned && player.hurtTime == 0 && offerRangedGrade(tick, feet)) return;
        if (result == AgentBody.HorizonResult.ARRIVED || result == AgentBody.HorizonResult.BLOCKED
                && (aligned || tick - rangedRetreat.aimedAt >= 35)) {
            if (shelterGoal != null) {
                clearShelter();
                shelterScanAfter = tick + 18;
            }
            advanceRangedSurvey(tick);
            // If the unavailable lane already faces a viable support, don't spin
            // away only to turn back for the wall after checking the other lanes.
            if (tryRangedWall(tick, coverSlot, protectsRoute, spend)) return;
        }
        status = "checking dry retreat footing: " + rangedFootingRefusal;
    }

    private void stopRangedWalk() {
        if (rangedRetreat.travel != null) body.stopHorizonTravel(rangedRetreat.travel);
        rangedRetreat.travel = null;
    }

    private void advanceRangedSurvey(int tick) {
        stopRangedWalk();
        rangedRetreat.next(tick);
    }

    private void preferRangedShelter(int tick, Vec3d feet) {
        if (shelterGoal != null && shelterGoal.squaredDistanceTo(feet) >= 0.04) {
            stopRangedWalk();
            rangedRetreat.prefer(tick, yaw(shelterGoal.subtract(feet)));
        }
    }

    private String rangedMovementStatus(boolean towardCover) {
        if (towardCover) return rangedRetreatReceipt ? "moving toward witnessed solid cover"
            : "requesting a checked stride toward witnessed solid cover";
        return rangedRetreatReceipt ? "continuing a voluntary dry retreat from ranged danger"
            : "requesting retreat on witnessed dry footing";
    }

    private boolean offerRangedGrade(int tick, Vec3d feet) {
        // Only the already aligned adjacent column can nominate one ordinary grade.
        var grade = body.ordinaryGrade(feet.add(Vec3d.fromPolar(0, rangedRetreat.bearing()).multiply(2)));
        if (grade == null) return false;
        stopRangedWalk();
        if (grade.lookOnly()) {
            rangedGradeLook = grade;
            rangedGradeLookBy = tick + 12;
            return lookAtRangedGrade(tick);
        }
        rangedGrade = AgentSurfaceTread.ordinaryGrade(grade.edge(), grade.from(), tick);
        return stepRangedGrade(tick);
    }

    private boolean lookAtRangedGrade(int tick) {
        var cue = rangedGradeLook;
        if (tick < rangedGradeLookBy && cue.from().equals(client.player.getBlockPos())) {
            if (body.renderedFrame() <= cue.frame() || !body.renderedAim(cue.topAim(), 8)) {
                body.aimUrgent(cue.topAim());
                status = "checking the exact top of a witnessed adjacent rise for retreat";
                return true;
            }
            var proved = body.ordinaryGradeAfterLook(cue);
            if (proved != null) rangedGrade = AgentSurfaceTread.ordinaryGrade(proved.edge(), proved.from(), tick);
        }
        rangedGradeLook = null;
        if (rangedGrade != null) return stepRangedGrade(tick);
        advanceRangedSurvey(tick);
        return false;
    }

    private boolean stepRangedGrade(int tick) {
        var tread = rangedGrade;
        switch (tread.step(client, body, tick)) {
            case CHECKING, MOVING -> status = "using a witnessed one-block dry tread to retreat";
            case LANDED -> {
                rangedGrade = null;
                rangedSurveyFrom = client.player.getPos();
                rangedRetreat.sector = 0;
                status = "landed on a witnessed dry tread; continuing the ranged retreat";
            }
            case REFUSED -> {
                rangedGrade = null;
                advanceRangedSurvey(tick);
                return false;
            }
        }
        return true;
    }

    private boolean holdsShelter(Vec3d feet) {
        return shelter != null && shelterState != null && rangedSource != null
            && Vec3d.ofCenter(shelter).squaredDistanceTo(feet) <= 16
            && body.rangedCoverState(shelter) == shelterState
            && (shelterUpper == null || body.rangedCoverState(shelter.up()) == shelterUpper)
            && blocksShotLine(coverBox(shelter, shelterUpper != null), rangedSource, feet, false);
    }

    private void clearShelter() {
        shelter = null;
        shelterState = shelterUpper = null;
        shelterGoal = null;
    }

    private static Vec3d shelterDestination(BlockPos pos, Vec3d feet, Vec3d source) {
        Box block = new Box(pos);
        if (blocksShotLine(block, source, feet, false)) return feet;
        Vec3d center = new Vec3d(pos.getX() + 0.5, feet.y, pos.getZ() + 0.5);
        Vec3d direction = center.subtract(source).multiply(1, 0, 1);
        if (direction.horizontalLengthSquared() < 0.5) return null;
        Vec3d target = center.add(direction.normalize().multiply(1.07));
        double distance = feet.squaredDistanceTo(target);
        // A candidate bearing is only a preference; the live walker still proves every stride.
        if (distance < 0.04 || distance > 3.8 * 3.8
                || turnDifference(yaw(target.subtract(feet)), yaw(feet.subtract(source))) > 100)
            return null;
        return blocksShotLine(block, source, target, false) ? target : null;
    }

    static boolean blocksShotLine(Box solid, Vec3d source, Vec3d feet, boolean crouched) {
        Vec3d line = source.subtract(feet);
        double length = line.horizontalLength();
        if (length < 0.75) return false;
        Box inset = solid.expand(-0.025);
        if (inset.contains(source)) return false;
        double sideX = 0.24 * line.z / length, sideZ = -0.24 * line.x / length;
        double chest = crouched ? 0.93 : 1.08, head = crouched ? 1.28 : 1.64;
        return inset.raycast(source, feet.add(sideX, chest, sideZ)).isPresent()
            && inset.raycast(source, feet.add(-sideX, chest, -sideZ)).isPresent()
            && inset.raycast(source, feet.add(sideX, head, sideZ)).isPresent()
            && inset.raycast(source, feet.add(-sideX, head, -sideZ)).isPresent();
    }

    private void evadeRangedFire(int tick) {
        var player = client.player;
        Vec3d feet = player.getPos();
        // Release the guard stance before a checked dodge; never inherit its crouch or use.
        body.pauseWork();
        body.prioritizeMovement();
        if (rangedHitNow || player.hurtTime > 0 && player.getVelocity().y > 0.06) {
            status = "under repeated fire; waiting for the hit impulse to settle";
            return;
        }
        if (!rangedFootworkStarted || rangedBlockedAt != null && feet.squaredDistanceTo(rangedBlockedAt) >= 0.36) {
            rangedFootwork.start(rangedFire.away());
            rangedFootworkStarted = true;
            rangedBlockedAt = null;
        }
        var action = rangedFootwork.step(feet, body.defensiveViewYaw(), body.defensiveViewPitch(), true,
            tick == rangedDriveTick + 1 && body.appliedEmergencyForward() && player.hurtTime == 0,
            false, body, body.recentEmergencyBearing());
        rangedRetreatReceipt = rangedFootwork.advanced();
        switch (action) {
            case ALIGN -> {
                body.turnUrgent(rangedFootwork.bearing(), AgentEmergencyFootwork.PITCH);
                status = "under repeated fire; checking for a short dry lane";
            }
            case DRIVE -> {
                body.driveCheckedEmergencyLane(rangedFootwork.landing(), rangedFootwork.bearing());
                rangedDriveTick = tick;
                status = rangedRetreatReceipt ? "under repeated fire; confirmed a voluntary dodge on a witnessed dry lane"
                    : "under repeated fire; requesting a dodge on a witnessed dry lane";
            }
            case BRACE -> {
                if (rangedBlockedAt == null) rangedBlockedAt = feet;
                body.sneak();
                status = "under repeated fire without usable protection; no short dry lane proved";
            }
        }
    }

    boolean confirmedCover() { return coverReceipt; }
    boolean confirmedRangedRetreat() { return rangedRetreatReceipt; }

    private static final class RangedWall {
        final BlockPos lower;
        final int deadline;
        BlockState base;
        Block material;
        int slot, count, issuedAt;
        boolean groundProved;

        RangedWall(BlockPos lower, int tick) {
            this.lower = lower;
            deadline = tick + 44;
        }
    }

    static Box coverBox(BlockPos lower, boolean twoHigh) {
        Box box = new Box(lower);
        return twoHigh ? box.stretch(0, 1, 0) : box;
    }

    private boolean tryRangedWall(int tick, int slot, Predicate<BlockPos> protectsRoute, Predicate<ItemStack> spend) {
        var player = client.player;
        Vec3d feet = player.getPos();
        var wall = rangedWall;
        if (player.isOnFire() || player.isInLava()) {
            rangedWall = null;
            rangedWallRefusal = "fire interrupts wall placement";
            return false;
        }
        if (wall == null) {
            if (shelter != null || rangedCoverTried) return false;
            if (slot < 0 || client.options.sneakKey.isUnbound()) {
                rangedWallRefusal = "no usable two-block hotbar stack and crouch";
                return false;
            }
            if (rangedSource == null || tick - rangedSightAt > 100) {
                rangedWallRefusal = "no recent witnessed shot line for a wall";
                return false;
            }
            if (player.hurtTime != 0 || player.getVelocity().horizontalLengthSquared() > 0.0025
                    || rangedEpisode.heardRecently(tick)) {
                rangedWallRefusal = "too exposed or unstable to stop and build";
                return false;
            }
            // Geometry can nominate one face to inspect, but only a rendered, supported
            // wall site can spend dirt. Don't turn into fire while a dry exit is available.
            Direction side = Direction.fromHorizontalDegrees(yaw(rangedSource.subtract(feet)));
            BlockPos lower = player.getBlockPos().offset(side);
            if (!usableRangedWall(lower, feet, protectsRoute)) {
                rangedWallRefusal = "adjacent wall would not cover the body";
                return false;
            }
            var floor = rangedWallFloor(lower);
            boolean visible = canSeeEmptyWall(lower, floor);
            if (!visible && !rangedRetreat.exhausted) return false;
            wall = new RangedWall(lower, tick);
            wall.groundProved = visible;
            rangedCoverTried = true;
            rangedWall = wall;
            stopRangedWalk();
        }

        if (tick >= wall.deadline || player.getVelocity().horizontalLengthSquared() > 0.0025
                || !usableRangedWall(wall.lower, feet, protectsRoute))
            return refuseRangedWall("wall site no longer reachable or protective");
        if (!wall.groundProved && rangedEpisode.heardRecently(tick))
            return refuseRangedWall("a new shot interrupted the wall survey");

        if (!wall.groundProved) {
            Vec3d preview = Vec3d.ofBottomCenter(wall.lower).add(0, 0.55, 0);
            var floor = rangedWallFloor(wall.lower);
            if (!canSeeEmptyWall(wall.lower, floor)) {
                if (body.renderedAim(preview, 5) && body.hasRecentView())
                    return refuseRangedWall("wall lacks a visible solid base and two clear cells");
                body.aimUrgent(preview);
                status = "checking the base and height of a possible dirt screen";
                return true;
            }
            wall.groundProved = true;
        }

        boolean upper = wall.base != null;
        BlockPos cell = upper ? wall.lower.up() : wall.lower;
        body.sneak();
        if (wall.material != null) {
            Vec3d point = Vec3d.ofCenter(cell);
            var actual = body.perceive(point, 3).orElse(null);
            if (actual != null && cell.equals(actual.getBlockPos())
                    && player.getInventory().getStack(wall.slot).getCount() < wall.count) {
                var state = body.rangedCoverState(cell);
                if (state != null && state.isOf(wall.material)) {
                    if (upper) {
                        shelter = wall.lower;
                        shelterState = wall.base;
                        shelterUpper = state;
                        coverReceipt = holdsShelter(feet);
                        rangedWall = null;
                        if (!coverReceipt) {
                            clearShelter();
                            return refuseRangedWall("placed blocks do not cover current footing");
                        }
                        status = "confirmed two placed blocks screening the last witnessed shot line";
                        return true;
                    }
                    wall.base = state;
                    wall.material = null;
                    status = "confirmed the base; one low block is not cover";
                    return true;
                }
            }
            if (tick - wall.issuedAt >= 10) return refuseRangedWall("vanilla did not confirm the cover placement");
            body.aimUrgent(point);
            status = "checking the placed block and hotbar count";
            return true;
        }

        if (slot < 0) return refuseRangedWall("no permitted hotbar block remains for the wall");
        if (upper && body.rangedCoverState(wall.lower) != wall.base)
            return refuseRangedWall("the placed base changed before the upper block");
        var floor = rangedWallFloor(cell);
        Vec3d point = Vec3d.ofBottomCenter(cell).add(0, -0.035, 0);
        if (floor == null || body.dryRouteClear(Vec3d.ofCenter(cell)) != AgentBody.DryRouteSample.CLEAR) {
            // Aim to keep both the top and the prospective cell inside the rendered view.
            body.aimUrgent(point.add(0, 0.23, 0));
            status = "checking the exact supported face for the " + (upper ? "upper block" : "base block");
            return true;
        }
        ItemStack stack = player.getMainHandStack();
        boolean equipped = coverMaterial(stack) && stack.getCount() >= (upper ? 1 : 2)
            && (spend == null || spend.test(stack));
        if (!equipped) selectRangedSlot(slot, tick);
        Block material = equipped ? ((BlockItem) stack.getItem()).getBlock() : null;
        boolean placement = equipped && player.isSneaking()
            && body.canPlaceRangedCoverAcross(floor, material.getDefaultState());
        if (!placement && equipped && player.isSneaking()) {
            var selected = body.selectedFace();
            if (selected != null && selected.getSide() == Direction.UP && selected.getBlockPos().equals(floor.getBlockPos()))
                return refuseRangedWall("vanilla refuses placement at the selected wall face");
        }
        var preparation = !equipped ? AgentBody.Preparation.EQUIPMENT
            : placement ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE;
        status = upper ? "aiming to stack the top of the ranged screen" : "aiming to place the supported screen base";
        if (body.useContact(floor, AgentBody.Contact.PLACE, preparation)) {
            wall.material = material;
            wall.slot = player.getInventory().selectedSlot;
            wall.count = stack.getCount();
            wall.issuedAt = tick;
        }
        return true;
    }

    private boolean usableRangedWall(BlockPos lower, Vec3d feet, Predicate<BlockPos> protectsRoute) {
        return rangedSource != null && !protectsRoute.test(lower) && !protectsRoute.test(lower.up())
            && !client.player.getBoundingBox().expand(0.08).intersects(coverBox(lower, true))
            && blocksShotLine(coverBox(lower, true), rangedSource, feet, false);
    }

    private boolean canSeeEmptyWall(BlockPos lower, BlockHitResult floor) {
        return floor != null && body.dryRouteClear(Vec3d.ofCenter(lower)) == AgentBody.DryRouteSample.CLEAR
            && body.dryRouteClear(Vec3d.ofCenter(lower.up())) == AgentBody.DryRouteSample.CLEAR;
    }

    private BlockHitResult rangedWallFloor(BlockPos cell) {
        Vec3d point = Vec3d.ofBottomCenter(cell).add(0, -0.035, 0);
        var hit = body.dryRouteFloor(point, cell.down());
        return hit != null && body.rangedCoverState(hit.getBlockPos()) != null ? hit : null;
    }

    private boolean refuseRangedWall(String reason) {
        rangedWall = null;
        rangedWallRefusal = reason;
        status = "ranged danger; " + reason;
        return false;
    }

    private boolean tryRangedCover(int tick, int slot, Predicate<BlockPos> protectsRoute, Predicate<ItemStack> spend) {
        var player = client.player;
        if (rangedCover != null) {
            Vec3d point = Vec3d.ofCenter(rangedCover);
            BlockHitResult receipt = body.perceive(point, 3).orElse(null);
            if (receipt != null && receipt.getBlockPos().equals(rangedCover)
                    && client.world.getBlockState(receipt.getBlockPos()).isOf(rangedCoverBlock)
                    && player.getInventory().getStack(rangedCoverSlot).getCount() < rangedCoverCount) {
                status = "confirmed a placed block of ranged cover";
                coverReceipt = true;
                rangedCover = null;
                return true;
            } else if (tick < rangedCoverUntil) {
                body.aimUrgent(point);
                status = "waiting for the cover placement to settle";
            } else rangedCover = null;
            return coverReceipt || rangedCover != null;
        }
        if (rangedCoverTried || slot < 0 || !Float.isFinite(rangedYaw)
                || rangedPitch < 0 || rangedPitch > 60
                || player.getVelocity().horizontalLengthSquared() > 0.0064) return false;
        var direction = Direction.fromHorizontalDegrees(rangedYaw);
        if (Math.abs(MathHelper.wrapDegrees(direction.getPositiveHorizontalDegrees() - rangedYaw)) > 23) return false;
        BlockPos cover = player.getBlockPos().offset(direction);
        if (protectsRoute.test(cover) || player.getBoundingBox().expand(0.08).intersects(new Box(cover))) return false;
        Vec3d point = Vec3d.ofBottomCenter(cover).add(0, -0.035, 0);
        BlockHitResult floor = body.terrain(point, player.getEyePos().distanceTo(point) + 0.08).orElse(null);
        if (floor == null || !floor.getBlockPos().equals(cover.down()) || floor.getSide() != Direction.UP
                || Math.abs(floor.getPos().y - cover.getY()) > 0.05
                || body.dryRouteClear(Vec3d.ofCenter(cover)) != AgentBody.DryRouteSample.CLEAR) {
            return false;
        }
        var support = client.world.getBlockState(floor.getBlockPos());
        if (support.isOf(Blocks.MAGMA_BLOCK) || !support.getFluidState().isEmpty()
                || !Block.isShapeFullCube(support.getCollisionShape(client.world, floor.getBlockPos()))) return false;
        ItemStack selected = player.getMainHandStack();
        boolean equipped = coverMaterial(selected) && (spend == null || spend.test(selected));
        if (!equipped) selectRangedSlot(slot, tick);
        status = "aiming at a witnessed face for ranged cover";
        var preparation = !equipped ? AgentBody.Preparation.EQUIPMENT
            : player.isSneaking() ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE;
        if (body.useContact(floor, AgentBody.Contact.PLACE, preparation)) {
            rangedCoverTried = true;
            rangedCover = cover;
            rangedCoverBlock = ((BlockItem) selected.getItem()).getBlock();
            rangedCoverUntil = tick + 10;
            rangedCoverSlot = player.getInventory().selectedSlot;
            rangedCoverCount = player.getMainHandStack().getCount();
            status = "placing one block between the ledge and ranged fire";
        }
        return true;
    }

    private void selectRangedSlot(int slot, int tick) {
        if (slot != client.player.getInventory().selectedSlot && tick >= rangedSelectAfter && body.tapHotbar(slot))
            rangedSelectAfter = tick + 4;
    }

    static boolean coverMaterial(ItemStack stack) {
        return stack.isOf(Items.COBBLESTONE) || stack.isOf(Items.COBBLED_DEEPSLATE)
            || stack.isOf(Items.STONE) || stack.isOf(Items.DIRT);
    }

    private static float yaw(Vec3d direction) {
        return (float) Math.toDegrees(Math.atan2(-direction.x, direction.z));
    }

    boolean checkZombieCue(AgentEars ears, int tick, boolean digging) {
        var player = client.player;
        if (!criticallyHurt(player) || !player.isOnGround() || player.isTouchingWater() || player.hasVehicle()
                || player.isUsingItem() || client.currentScreen != null || !body.hasRecentView()) {
            stopZombieLook();
            return false;
        }
        if (zombieLook == null) {
            if (!digging || tick < zombieLookAfter) return false;
            zombieLook = ears.takeFreshZombieCue();
            if (zombieLook == null) return false;
            zombieLookYaw = ears.zombieBearing();
            zombieLookUntil = System.nanoTime() + ZOMBIE_LOOK_NANOS;
            zombieLookAfter = tick + 70;
            zombieLookAligned = 0;
        } else if (zombieLookAligned >= 3 || System.nanoTime() - zombieLookUntil >= 0) {
            stopZombieLook();
            return false;
        }
        if (Math.abs(MathHelper.wrapDegrees(zombieLookYaw - player.getYaw())) <= 10
                && Math.abs(ZOMBIE_LOOK_PITCH - player.getPitch()) <= 8) zombieLookAligned++;
        else zombieLookAligned = 0;
        // This is a stationary camera check, not a combat target or a movement bearing.
        body.turnUrgent(zombieLookYaw, ZOMBIE_LOOK_PITCH);
        status = zombieLook.status;
        return true;
    }

    boolean combatSelecting() {
        if (!hands.busy()) combatSelecting = false;
        return combatSelecting;
    }

    void cancelSelection() { combatSelecting = false; }

    void forgetContact() {
        lastThreat = null;
        aim = null;
    }

    boolean holdCombatView() {
        if (aim == null) return false;
        var player = client.player;
        if (body.actionTick() - seenAt > COMBAT_VIEW_GRACE || !body.combatViewMissing()
                || !player.isOnGround() || player.isTouchingWater() || player.hasVehicle()) {
            forgetContact();
            return false;
        }
        // Keep aiming at the observed point. Do not follow a moving entity or request an attack.
        body.aimUrgent(aim);
        body.holdRaisedShieldToward(aim);
        status = "holding the last visible combat bearing";
        return true;
    }

    boolean canPrepare(int tick) {
        return tick >= calmAfter && !client.player.isUsingItem() && body.hasRecentView();
    }

    boolean recentlyThreatened(int tick) {
        return calmAfter != 0 && tick - calmAfter < 160;
    }

    boolean prepare(AgentProgress progress, int tick, int reserve, int sparePlanks, int sticks, boolean beforePortal) {
        status = null;
        var player = client.player;

        boolean offhand = SHIELD.test(player.getOffHandStack());
        boolean shield = offhand || hands.count(SHIELD) > 0;
        hadShield |= shield;
        if (!offhand && shield) {
            if (SHIELD.test(player.getMainHandStack())) {
                if (swapShield(tick)) return true;
            } else if (equip(tick, SHIELD)) {
                status = "selecting a shield for the offhand";
                return true;
            }
        }

        int iron = hands.count(INGOT);
        if (!shield && sparePlanks >= SHIELD_PLANKS) {
            // Spend one ingot after the pick, even before the portal reserve is complete.
            // Replacements must come from surplus so repeated losses cannot drain the reserve.
            if (iron > (hadShield || !beforePortal ? reserve : 0)
                    && workshop(progress, tick, "shield", SHIELD_PLANKS, 0)) return true;
            if (beforePortal && !hadShield && iron == 0) {
                if (seekIronUntil == 0) seekIronUntil = tick + 180;
                if (tick < seekIronUntil) {
                    progress.acquireIron(1);
                    return true;
                }
            }
        }

        if (beforePortal && bestWeapon(PlayerInventory.HOTBAR_SIZE, true) < 0) {
            int stored = bestWeapon(PlayerInventory.MAIN_SIZE, true);
            if (stored >= PlayerInventory.HOTBAR_SIZE) {
                if (tick >= equipAfter) {
                    equipAfter = tick + 45;
                    hands.equipSlot(stored);
                    if (hands.busy()) {
                        status = "moving a weapon to the hotbar";
                        return true;
                    }
                }
            } else if (sparePlanks >= (sticks < 3 ? 2 : 0) && hands.count(STONE) >= 2
                    && workshop(progress, tick, "stone_sword", 0, 1)) {
                return true;
            }
        }

        int stickReservePlanks = sticks < 2 ? 2 : 0;
        for (Armor piece : ARMOR) {
            ItemStack worn = player.getEquippedStack(piece.slot);
            if (worn.hasEnchantments() || armorPoints(worn.getOrDefault(
                    DataComponentTypes.ATTRIBUTE_MODIFIERS, AttributeModifiersComponent.DEFAULT), piece.slot)
                    >= piece.protection) continue;
            if (hands.count(piece.matches) > 0) {
                if (wear(tick, piece)) return true;
            } else if (offhand && sparePlanks >= stickReservePlanks && beforePortal && iron - reserve >= piece.cost
                    && workshop(progress, tick, piece.recipe, 0, 0)) {
                return true;
            }
        }
        return false;
    }

    private boolean equip(int tick, Predicate<ItemStack> matches) {
        if (tick < equipAfter) return false;
        equipAfter = tick + 45;
        return hands.equip(matches);
    }

    private boolean swapShield(int tick) {
        if (tick >= swapAfter) {
            swapAfter = tick + 45;
            if (body.swapShieldToOffhand()) swapWaitUntil = tick + 8;
        }
        if (tick >= swapWaitUntil) return false;
        status = "swapping shield to offhand";
        return true;
    }

    private boolean wear(int tick, Armor piece) {
        if (tick < wearAfter) return false;
        if (!piece.matches.test(client.player.getMainHandStack())) {
            if (!equip(tick, piece.matches)) return false;
            status = "selecting armor to equip";
            return true;
        }
        if (wearing != piece) {
            wearing = piece;
            wearUntil = tick + 14;
        } else if (tick >= wearUntil) {
            wearAfter = tick + 80;
            wearing = null;
            return false;
        }
        body.turnFixed(client.player.getYaw(), -45);
        body.wearArmor(piece.item);
        status = "using armor to equip it";
        return true;
    }

    private boolean workshop(AgentProgress progress, int tick, String recipe, int planks, int sticks) {
        if (tick < workshopAfter || !progress.defenseBenchAvailable()) return false;
        if (!recipe.equals(workshopRecipe)) {
            workshopRecipe = recipe;
            workshopUntil = tick + 100;
        } else if (tick >= workshopUntil) {
            workshopRecipe = null;
            workshopAfter = tick + 100;
            return false;
        }
        progress.requestTable(recipe, null, planks, sticks);
        return true;
    }

    /** True if Progress should try a visible, terrain-checked approach this tick. */
    boolean fight(LivingEntity threat, int tick, Predicate<ItemStack> spend) {
        markDanger(tick);
        var player = client.player;
        if (lastThreat != threat || tick - lastEngaged > 3) engagementStarted = tick;
        lastThreat = threat;
        lastEngaged = tick;
        seenAt = body.actionTick();
        aim = body.threatPoint();
        face();

        boolean mainShield = SHIELD.test(player.getMainHandStack()) && canWear(player.getMainHandStack(), spend);
        boolean offhand = SHIELD.test(player.getOffHandStack()) && canWear(player.getOffHandStack(), spend);
        if (mainShield && !offhand && swapShield(tick)) return false;
        if (!mainShield || offhand) selectWeapon(offhand, spend);

        if (body.strikeTarget(threat)) {
            if (!combatSelecting() && canWear(player.getMainHandStack(), spend)
                    && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                // Vanilla discards attack edges in the tick that releases item use.
                if (player.isUsingItem()) status = "releasing item use for a timed strike";
                else {
                    body.strike(threat);
                    status = "lining up a charged strike on a visible hostile";
                }
                return false;
            }
            guard(threat, mainShield || offhand);
            return false;
        }
        guard(threat, mainShield || offhand);
        double distance = player.squaredDistanceTo(threat);
        // Let an angry Enderman close on our footing rather than following its teleports.
        return !(threat instanceof EndermanEntity) && distance > 2.65 * 2.65
            && (threat instanceof RangedAttackMob || !mainShield && !offhand
            || distance > 4.4 * 4.4 || tick - engagementStarted >= 14);
    }

    boolean reserveRequiresRetreat(Predicate<ItemStack> spend) {
        if (spend == null) return false;
        var p = client.player;
        return !canWear(p.getMainHandStack(), spend) && (!SHIELD.test(p.getOffHandStack())
            || !canWear(p.getOffHandStack(), spend)) && bestWeapon(PlayerInventory.HOTBAR_SIZE, true, spend) < 0;
    }

    private static boolean canWear(ItemStack stack, Predicate<ItemStack> spend) {
        return spend == null || !stack.isDamageable() || spend.test(stack);
    }

    void face() {
        body.aimUrgent(aim);
    }

    private void guard(LivingEntity threat, boolean shield) {
        // Vanilla selects the queued weapon before using; don't raise a shield based on the old hand.
        if (shield && (client.player.isUsingItem() || !combatSelecting())) body.blockAgainst(threat);
        status = client.player.isBlocking() && SHIELD.test(client.player.getActiveItem())
            ? "shield raised; tracking a visible hostile"
            : shield ? "facing a visible hostile with a shield" : "facing a visible hostile";
    }

    private void selectWeapon(boolean shield, Predicate<ItemStack> spend) {
        if (hands.busy()) return;
        var player = client.player;
        var inventory = player.getInventory();
        ItemStack main = inventory.getMainHandStack();
        boolean allowAxe = !shield || player.isUsingItem() || !body.shieldStartWouldUseBlock();
        int target = bestWeapon(PlayerInventory.HOTBAR_SIZE, allowAxe, spend);
        if (target < 0 && shield && (!AgentBody.shieldSafeMainHand(main) || !allowAxe && main.isIn(ItemTags.AXES))) {
            for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
                if (client.options.hotbarKeys[slot].isUnbound()) continue;
                ItemStack stack = inventory.getStack(slot);
                if (stack.isIn(ItemTags.PICKAXES)) {
                    target = slot;
                    break;
                }
                if (target < 0 && stack.isEmpty()) target = slot;
            }
        }
        if (target >= 0 && target != inventory.selectedSlot) {
            hands.equipSlot(target);
            combatSelecting = hands.busy();
        }
    }

    private int bestWeapon(int limit, boolean allowAxe) {
        return bestWeapon(limit, allowAxe, null);
    }

    private int bestWeapon(int limit, boolean allowAxe, Predicate<ItemStack> spend) {
        var inventory = client.player.getInventory();
        int best = -1;
        double score = 0;
        for (int slot = 0; slot < limit; slot++) {
            if (slot < PlayerInventory.HOTBAR_SIZE && slot != inventory.selectedSlot
                    && client.options.hotbarKeys[slot].isUnbound()) continue;
            ItemStack stack = inventory.getStack(slot);
            if (!canWear(stack, spend)) continue;
            boolean sword = stack.isIn(ItemTags.SWORDS);
            if (!sword && (!allowAxe || !stack.isIn(ItemTags.AXES))) continue;
            var entries = stack.getOrDefault(DataComponentTypes.ATTRIBUTE_MODIFIERS, AttributeModifiersComponent.DEFAULT)
                .modifiers();
            double damage = 1, speed = 4;
            for (int i = 0; i < entries.size(); i++) {
                var entry = entries.get(i);
                if (!entry.slot().matches(EquipmentSlot.MAINHAND)) continue;
                if (entry.attribute().equals(EntityAttributes.ATTACK_DAMAGE)) damage += entry.modifier().value();
                if (entry.attribute().equals(EntityAttributes.ATTACK_SPEED)) speed += entry.modifier().value();
            }
            // Swords can raise the offhand shield over a block without an axe use taking priority.
            double candidate = damage * speed + (sword ? 0.25 : 0);
            if (candidate > score || candidate == score && slot == inventory.selectedSlot) {
                best = slot;
                score = candidate;
            }
        }
        return best;
    }

    private static double armorPoints(AttributeModifiersComponent modifiers, EquipmentSlot slot) {
        var entries = modifiers.modifiers();
        double points = 0;
        for (int i = 0; i < entries.size(); i++) {
            var entry = entries.get(i);
            if (entry.slot().matches(slot) && entry.attribute().equals(EntityAttributes.ARMOR)) {
                points += entry.modifier().value();
            }
        }
        return points;
    }
}
