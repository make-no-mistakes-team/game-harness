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
    private static final int MELEE_REORIENT_TICKS = 16;
    private static final long RANGED_ALERT_NANOS = 2_400_000_000L;
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
    private BlockState shelterState;
    private Vec3d shelterGoal;
    private boolean crouchShelter, sheltered;
    private int shelterScanAfter, shelterUntil, rangedPlacementBy;
    private float lastShotYaw, lastShotPitch;
    private AgentBody.OrdinaryGrade rangedGradeLook;
    private AgentSurfaceTread rangedGrade;
    private int rangedGradeLookBy;
    private final MeleeRecovery melee = new MeleeRecovery();
    private Vec3d meleeStart, meleeSurveyFrom;
    private LivingEntity meleeVisible, meleeAttacker;
    private float meleeAway = Float.NaN;
    private float meleeHeading, meleeListenYaw = Float.NaN;
    private float meleeLane = Float.NaN;
    private int meleeTurn, meleeTurnSince, meleeSamples, meleeAttackerTick, meleeListenAt, meleeListenUntil;
    private boolean meleeFreshHit, meleeListened;
    private float meleeLookPitch;
    private String meleeRefusal;
    private Vec3d meleeDriveFrom;
    private int meleeDriveTick;
    private float meleeDriveYaw;
    private boolean meleeDriveConfirmed, meleeDrove;
    private double meleeMotionBefore;

    /** Repeated impacts survive missing frames and wet footing; only dry play can take back ownership. */
    static final class MeleeRecovery {
        private static final int QUIET_AFTER_HIT = 32;
        private static final int EVIDENCE_LIMIT = 64;
        private static final int PINNED_LIMIT = 100;
        enum Evidence { NONE, AMBIENT, CONTACT, IMPACT }
        enum Footing { DRY, WET, UNSETTLED, VEHICLE }

        private int lastEvidence = -EVIDENCE_LIMIT;
        private int lastHit = -QUIET_AFTER_HIT;
        private boolean active, pinned, shoreNeeded, settledBank;

        static boolean canSprint(double seen, double speed, int hunger, boolean sprinting) {
            return hunger > 6 && seen >= Math.max(sprinting ? 2.1 : 2.5, 1.4 + 3.2 * speed);
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

    boolean observeMelee(AgentEars ears, LivingEntity visible, boolean hurt, boolean healingMeal, int tick,
                        Predicate<ItemStack> spend) {
        var player = client.player;
        var footing = player.hasVehicle() ? MeleeRecovery.Footing.VEHICLE
            : player.isTouchingWater() ? MeleeRecovery.Footing.WET
            : player.isOnGround() && player.hurtTime == 0 && !player.isOnFire() ? MeleeRecovery.Footing.DRY
            : MeleeRecovery.Footing.UNSETTLED;
        Vec3d feet = player.getPos();
        double distance = visible == null ? Double.POSITIVE_INFINITY : player.squaredDistanceTo(visible);
        boolean closeMelee = distance <= 5.0 * 5.0
            && (visible instanceof ZombieEntity || !(visible instanceof RangedAttackMob) && distance <= 3.4 * 3.4);
        boolean wounded = criticallyHurt(player) || healingMeal;
        meleeVisible = closeMelee ? visible : null;
        var cue = ears.recentMeleeCue();
        // Damage without an identified source warrants defense, not permission to attack.
        // Burning and hunger loss alone must not suppress their own recovery.
        boolean hit = hurt && !player.isOnFire()
            && (player.getHungerManager().getFoodLevel() > 0 || closeMelee || cue != null && player.hurtTime > 0);
        meleeFreshHit = hit;
        boolean close = closeMelee && (wounded || meleeOutmatched(spend));
        double movedX = meleeStart == null ? 0 : feet.x - meleeStart.x;
        double movedZ = meleeStart == null ? 0 : feet.z - meleeStart.z;
        boolean separated = meleeDrove && movedX * movedX + movedZ * movedZ >= 5 * 5
            && distance >= 6 * 6 && body.hasRecentView() && footing == MeleeRecovery.Footing.DRY;
        boolean started = !melee.active;
        var evidence = hit ? MeleeRecovery.Evidence.IMPACT : close ? MeleeRecovery.Evidence.CONTACT
            : cue != null ? MeleeRecovery.Evidence.AMBIENT : MeleeRecovery.Evidence.NONE;
        if (!melee.observe(tick, evidence, player.getHealth() <= 4, separated, footing)) {
            meleeAttacker = null;
            return false;
        }
        if (started) {
            meleeStart = feet;
            meleeHeading = player.getYaw();
            meleeAway = meleeListenYaw = Float.NaN;
            meleeListened = false;
            meleeListenUntil = 0;
            meleeDriveFrom = null;
            meleeDriveConfirmed = meleeDrove = false;
            resetMeleeSurvey(feet, tick);
        }
        if (closeMelee && (hit || melee.recentImpact(tick)) && body.visiblyCorroboratesMeleeImpact(visible)) {
            meleeAttacker = visible;
            meleeAttackerTick = tick;
        }
        float away = Float.NaN, impulseLook = Float.NaN;
        if (closeMelee) {
            away = yaw(feet.subtract(visible.getPos()));
        } else if (hit || melee.recentImpact(tick)) {
            Vec3d impulse = player.getVelocity();
            if (player.hurtTime > 0 && impulse.y > 0.06 && impulse.horizontalLengthSquared() >= 0.0064) {
                away = yaw(impulse);
                impulseLook = away + 180;
            }
        }
        boolean facesVisibleThreat = closeMelee && turnDifference(away, meleeLane) >= 112;
        if (facesVisibleThreat || Float.isFinite(away) && !Float.isFinite(meleeLane)
                && (!Float.isFinite(meleeAway) || hit && turnDifference(away, meleeAway) >= 100)) {
            meleeAway = away;
            resetMeleeSurvey(feet, tick);
        }
        // An audible groan or our own knockback can change where we look, never what we attack.
        if (!meleeListened && meleeListenUntil == 0 && !closeMelee && (wounded || melee.recentImpact(tick))
                && (cue != null || Float.isFinite(impulseLook))) {
            meleeListenYaw = cue != null ? cue.yaw() : impulseLook;
            meleeListenAt = tick;
        }
        return true;
    }

    LivingEntity meleeAttacker(int tick) {
        return melee.active && tick - meleeAttackerTick < MeleeRecovery.QUIET_AFTER_HIT ? meleeAttacker : null;
    }
    boolean recentMeleeImpact(int tick) { return melee.recentImpact(tick); }

    boolean retreatFromEnderman(LivingEntity threat, Predicate<ItemStack> spend) {
        return threat instanceof EndermanEntity && (body.threatPoint() == null || meleeOutmatched(spend));
    }

    private boolean meleeOutmatched(Predicate<ItemStack> spend) {
        var player = client.player;
        int weapon = bestWeapon(PlayerInventory.HOTBAR_SIZE, true, spend);
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
            if (result == AgentWaterEscape.Result.BLOCKED && client.player.getAir() >= AgentWaterEscape.MIN_WORK_AIR
                    && (defendWithHeldMeleeKit(tick, spend, false, true) || checkMeleeSound(tick))) return;
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
            meleeDriveConfirmed = MeleeRecovery.checkedStride(body.appliedEmergencyForward(), player.isOnGround(),
                meleeFreshHit || player.hurtTime != 0, change.dotProduct(Vec3d.fromPolar(0, meleeDriveYaw)),
                change.y, meleeMotionBefore);
            meleeDrove |= meleeDriveConfirmed;
        }
        if (meleeFreshHit || !player.isOnGround()) {
            if (!checkMeleeSound(tick)) meleeStatus("waiting for grounded dry footing before moving");
            return;
        }
        if (feet.squaredDistanceTo(meleeSurveyFrom) >= 1.4 * 1.4) {
            float continuing = meleeLane;
            resetMeleeSurvey(feet, tick);
            meleeLane = continuing;
        }
        float knownYaw = body.recentEmergencyBearing();
        boolean knownRetreat = Float.isFinite(knownYaw)
            && (!Float.isFinite(meleeAway) || turnDifference(knownYaw, meleeAway) <= 92);
        if (!Float.isFinite(meleeLane)) {
            if (defendWithHeldMeleeKit(tick, spend, true, false)) return;
            if ((!knownRetreat || meleeTurn > 0) && checkMeleeSound(tick)) return;
        }
        if (meleeTurn < MELEE_ESCAPE_TURNS.length || Float.isFinite(meleeLane)) {
            float facing = player.getYaw();
            float anchor = Float.isFinite(meleeAway) ? meleeAway : meleeHeading;
            float bearing = Float.isFinite(meleeLane) ? meleeLane
                : knownRetreat && meleeTurn == 0 ? knownYaw
                : anchor + MELEE_ESCAPE_TURNS[meleeTurn];
            body.turnUrgent(bearing, meleeLookPitch);
            if (turnDifference(facing, bearing) <= 8 && Math.abs(player.getPitch() - meleeLookPitch) <= 11
                    && body.renderedDirection(bearing, meleeLookPitch, 12)) {
                double width = player.getWidth() * 0.5 + 0.055;
                Vec3d lane = Vec3d.fromPolar(0, facing);
                Vec3d landing = meleeLane(feet, lane, facing, width, dangerous);
                if (landing != null) {
                    meleeLane = bearing;
                    meleeSamples = 0;
                    meleeDriveFrom = feet;
                    meleeDriveTick = tick;
                    meleeDriveYaw = facing;
                    meleeMotionBefore = player.getVelocity().dotProduct(lane);
                    double shown = Math.sqrt(feet.squaredDistanceTo(landing));
                    double speed = Math.sqrt(player.getVelocity().horizontalLengthSquared());
                    body.driveEmergencyLane(landing, facing, meleeLookPitch,
                        MeleeRecovery.canSprint(shown, speed, player.getHungerManager().getFoodLevel(), player.isSprinting()));
                    meleeStatus(meleeDriveConfirmed ? "confirmed voluntary retreat on a witnessed dry lane"
                        : "requesting retreat on a witnessed dry lane");
                    return;
                }
                if (++meleeSamples >= 2) nextMeleeView(tick);
                meleeStatus("checking dry retreat footing; " + meleeRefusal);
            } else {
                if (tick - meleeTurnSince >= 30 && body.hasRecentView()) nextMeleeView(tick);
                meleeStatus(body.hasRecentView() ? "aligning the retreat view" : "waiting for a rendered retreat view");
            }
            return;
        }
        // No path was witnessed. Do not run blindly, back over an edge, or open inventory.
        if (defendWithHeldMeleeKit(tick, spend, true, true)) return;
        body.sneak();
        meleeStatus("no safe dry retreat witnessed"
            + (meleeVisible == null ? "; no hostile in the current view" : "; no usable held defense against the visible hostile")
            + (meleeRefusal == null ? "" : "; " + meleeRefusal));
    }

    private void meleeStatus(String action) {
        status = (meleeFreshHit ? "melee emergency (fresh damage): " : "melee emergency: ") + action;
    }

    boolean confirmedMeleeRetreat() { return meleeDriveConfirmed; }

    private boolean checkMeleeSound(int tick) {
        if (meleeVisible != null || meleeListened || !Float.isFinite(meleeListenYaw)) return false;
        if (meleeListenUntil == 0) {
            if (tick - meleeListenAt >= MELEE_REORIENT_TICKS) return false;
            meleeListenUntil = tick + MELEE_REORIENT_TICKS;
        }
        if (tick >= meleeListenUntil || body.renderedDirection(meleeListenYaw, ZOMBIE_LOOK_PITCH, 12)) {
            meleeListened = true;
            // The next tick observes a new view, or returns to proving retreat footing.
            meleeTurnSince = tick;
            return false;
        }
        body.turnUrgent(meleeListenYaw, ZOMBIE_LOOK_PITCH);
        meleeStatus("reorienting from a nearby sound or hit impulse; hostile not confirmed");
        return true;
    }

    private boolean defendWithHeldMeleeKit(int tick, Predicate<ItemStack> spend, boolean allowShield, boolean seekContact) {
        if (meleeVisible == null || !body.hasRecentView() || body.threatPoint() == null) return false;
        var player = client.player;
        ItemStack main = player.getMainHandStack(), offhand = player.getOffHandStack();
        ItemStack shield = SHIELD.test(main) ? main : offhand;
        if (allowShield && !client.options.useKey.isUnbound() && SHIELD.test(shield) && canWear(shield, spend)
                && !player.getItemCooldownManager().isCoolingDown(shield) && AgentBody.shieldSafeMainHand(main)
                && !(main.isIn(ItemTags.AXES) && body.shieldStartWouldUseBlock())) {
            body.sneak();
            body.aimUrgent(body.threatPoint());
            body.blockAgainst(meleeVisible);
            meleeStatus(player.isBlocking() && SHIELD.test(player.getActiveItem())
                ? "shield raised against a visible melee threat" : "raising a held shield toward a visible melee threat");
            return true;
        }
        if (client.options.attackKey.isUnbound()) return false;
        boolean readyTool = (main.isIn(ItemTags.SWORDS) || main.isIn(ItemTags.AXES) || main.isIn(ItemTags.PICKAXES))
            && canWear(main, spend);
        if (readyTool && !player.isUsingItem() && player.getAttackCooldownProgress(0.5f) >= 0.9f
                && body.renderedMeleeStrike(meleeVisible)) {
            body.strike(meleeVisible);
            meleeStatus("requesting a charged defensive strike at a confirmed hostile under the crosshair");
            return true;
        }
        if (!seekContact) return false;
        int weapon = readyTool ? -1 : meleeToolSlot(spend);
        if (!readyTool && weapon < 0) return false;
        body.aimUrgent(body.threatPoint());
        if (weapon >= 0) selectRangedSlot(weapon, tick);
        meleeStatus(readyTool ? "holding a tool on a visible hostile; waiting for a reachable, charged strike"
            : "selecting a carried weapon while facing a visible hostile");
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
    }

    /** An audible shot can corroborate a hit, but cannot by itself start or indefinitely renew flight. */
    static final class RangedEpisode {
        private static final int QUIET_TICKS = 90, SHOT_TO_HIT_TICKS = 18, COVER_QUIET_TICKS = 18;
        private int evidenceAt, coveredSince = -1, heardAt = -SHOT_TO_HIT_TICKS - 1;
        private boolean active, hit;

        boolean observe(int tick, boolean archerSeen, boolean shot, boolean damaged, boolean behindCover) {
            if (shot) heardAt = tick;
            boolean recent = active && tick - evidenceAt < QUIET_TICKS;
            hit = damaged && (archerSeen || recent || heardRecently(tick));
            if (archerSeen || hit) evidenceAt = tick;
            if (!behindCover || archerSeen || hit || !recent) coveredSince = -1;
            else if (coveredSince < 0) coveredSince = tick;
            active = (archerSeen || hit || recent) && (coveredSince < 0 || tick - coveredSince < COVER_QUIET_TICKS);
            return active;
        }

        private boolean heardRecently(int tick) { return tick - heardAt <= SHOT_TO_HIT_TICKS; }

        void reset() {
            active = hit = false;
            heardAt = -SHOT_TO_HIT_TICKS - 1;
            coveredSince = -1;
        }
    }

    /** Retain a rolling dry bearing. A lost tread asks for another rendered view, not a blind stride. */
    static final class RangedRetreat {
        private static final float[] TURNS = {44, 82, 103, 0, -44, -82, -103};
        private float away, bearing, side;
        private double dirX, dirZ;
        private int sector, missed, stalled, aimedAt;
        private Vec3d lastFeet, landing;
        private boolean advanced, exhausted;

        void start(int tick, float away, float now) {
            this.away = away;
            side = MathHelper.wrapDegrees(now - away) < 0 ? -1 : 1;
            sector = 0;
            exhausted = false;
            if (turnDifference(away, now) <= 105) setBearing(tick, now);
            else {
                sector = 1;
                setBearing(tick, away + side * TURNS[sector++]);
            }
        }

        void prefer(int tick, float towardCover) {
            if (turnDifference(away, towardCover) <= 110) {
                exhausted = false;
                setBearing(tick, towardCover);
            }
        }

        void next(int tick) {
            while (sector < TURNS.length) {
                float candidate = away + side * TURNS[sector++];
                if (turnDifference(candidate, bearing) > 18) {
                    setBearing(tick, candidate);
                    return;
                }
            }
            exhausted = true;
        }

        private void setBearing(int tick, float requested) {
            bearing = MathHelper.wrapDegrees(requested);
            double radians = Math.toRadians(bearing);
            dirX = -Math.sin(radians);
            dirZ = Math.cos(radians);
            aimedAt = tick;
            missed = stalled = 0;
            lastFeet = landing = null;
        }

        AgentEmergencyFootwork.Action step(int tick, Vec3d feet, float viewYaw, float viewPitch,
                                          boolean applied, AgentEmergencyFootwork.Terrain terrain) {
            landing = null;
            advanced = applied && lastFeet != null && Math.abs(feet.y - lastFeet.y) < 0.055
                && (feet.x - lastFeet.x) * dirX + (feet.z - lastFeet.z) * dirZ >= 0.025;
            if (applied) stalled = advanced ? 0 : stalled + 1;
            lastFeet = feet;
            if (exhausted) return AgentEmergencyFootwork.Action.BRACE;
            if (!aligned(viewYaw, viewPitch)) {
                if (Float.isFinite(viewYaw) && tick - aimedAt >= 26) next(tick);
                return AgentEmergencyFootwork.Action.ALIGN;
            }
            if (stalled < 3 && !terrain.obstructed(bearing)) landing = terrain.dryLanding(bearing);
            if (landing != null) {
                missed = 0;
                return AgentEmergencyFootwork.Action.DRIVE;
            }
            if (++missed >= 2) next(tick);
            return AgentEmergencyFootwork.Action.ALIGN;
        }

        boolean aligned(float yaw, float pitch) {
            return turnDifference(yaw, bearing) <= AgentEmergencyFootwork.DRIVE_ALIGNMENT
                && Math.abs(pitch - AgentEmergencyFootwork.PITCH) <= 8;
        }

        float bearing() { return bearing; }
        boolean advanced() { return advanced; }
        Vec3d landing() { return landing; }
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
        boolean wasActive = rangedEpisode.active;
        boolean meleeHit = nearest != null && !(nearest instanceof RangedAttackMob)
            && body.visiblyCorroboratesMeleeImpact(nearest);
        rangedHitNow = hurt && !player.isOnFire() && !player.isTouchingWater() && !meleeHit;
        sheltered = wasActive && seen == null && !rangedHitNow && player.isOnGround() && !player.isTouchingWater()
            && holdsShelter(player.getPos());
        boolean settled = sheltered && (!crouchShelter || player.isSneaking())
            && player.getVelocity().horizontalLengthSquared() <= 0.0025;
        if (!rangedEpisode.observe(tick, seen != null, cue != null, rangedHitNow, settled)) {
            if (wasActive) clearOrdinaryRanged();
            return false;
        }
        if (!wasActive) {
            rangedCoverTried = false;
            rangedPlacementBy = 0;
            shelterScanAfter = tick;
            rangedSurveyFrom = null;
            rangedYaw = Float.NaN;
            rangedPitch = 10;
        }
        float previous = rangedYaw;
        if (seen != null) {
            rangedSource = seen;
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
            } else if (rangedSource == null && player.getVelocity().horizontalLengthSquared() > 0.0064) {
                rangedYaw = MathHelper.wrapDegrees(yaw(player.getVelocity()) + 180);
            }
        }
        if (Float.isFinite(previous) && (turnDifference(previous, rangedYaw) > 60
                || seen != null && rangedSurveyFrom != null && turnDifference(rangedRetreat.bearing(), rangedYaw) < 65))
            rangedSurveyFrom = null;
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

    private void clearOrdinaryRanged() {
        clearShelter();
        rangedSource = rangedSurveyFrom = null;
        rangedGrade = null;
        rangedGradeLook = null;
        rangedCover = null;
        rangedDriveTick = -1;
        sheltered = false;
    }

    boolean observeRanged(AgentEars ears, LivingEntity visible, boolean hurt, int tick) {
        rangedHitNow = hurt && !client.player.isOnFire();
        var cue = ears.takeFreshRangedCue();
        boolean active = rangedActive();
        Vec3d seen = hurt && visible instanceof RangedAttackMob
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
        coverReceipt = rangedRetreatReceipt = false;
        markDanger(tick);
        forgetContact();
        body.prioritizeMovement();
        var player = client.player;
        status = ordinary ? "withdrawing from ranged danger"
            : rangedAudible ? "responding to a nearby skeleton shot" : "responding to a visible archer";
        // The fall controller has already had priority. Never add a movement key to the impulse.
        if (ordinary && (rangedEpisode.hit || player.hurtTime > 0 && player.getVelocity().y > 0.06)) {
            rangedGrade = null;
            rangedGradeLook = null;
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
            if (crouchShelter) body.sneak();
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
            if (coverMaterial(stack)) {
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
                && tryRangedCover(tick, coverSlot, protectsRoute, spend, false)) return;
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
        float away = Float.isFinite(rangedYaw) ? MathHelper.wrapDegrees(rangedYaw + 180) : player.getYaw();
        if (shelter != null && (body.rangedCoverState(shelter) != shelterState
                || shelterGoal != null && (tick >= shelterUntil || feet.squaredDistanceTo(shelterGoal) > 5 * 5)))
            clearShelter();
        if (rangedSurveyFrom == null) {
            rangedSurveyFrom = feet;
            rangedRetreat.start(tick, away, player.getYaw());
            preferRangedShelter(tick, feet);
        }
        if (shelter == null && rangedSource != null && tick >= shelterScanAfter && body.hasRecentView()) {
            shelterScanAfter = tick + 4;
            var found = body.visibleRangedCover(pos -> shelterDestination(pos, feet, rangedSource) != null);
            if (found != null) {
                shelter = found.getBlockPos();
                shelterState = body.rangedCoverState(shelter);
                shelterGoal = shelterDestination(shelter, feet, rangedSource);
                shelterUntil = tick + 30;
                if (body.rangedThreatPoint() == null && holdsShelter(feet)) {
                    body.pauseWork();
                    status = "holding solid cover across the last witnessed shot line";
                    return;
                }
                preferRangedShelter(tick, feet);
            }
        }
        // A visible natural screen or a usable rolling lane takes precedence over stopping to build.
        if (rangedCover != null && tryRangedCover(tick, coverSlot, protectsRoute, spend, true)) return;
        if (rangedGradeLook != null && lookAtRangedGrade(tick)) return;
        float before = rangedRetreat.bearing();
        var action = rangedRetreat.step(tick, feet, body.defensiveViewYaw(), body.defensiveViewPitch(),
            tick == rangedDriveTick + 1 && body.appliedEmergencyForward() && player.hurtTime == 0, body);
        rangedRetreatReceipt = rangedRetreat.advanced();
        switch (action) {
            case ALIGN -> {
                if (before == rangedRetreat.bearing() && player.hurtTime == 0
                        && rangedRetreat.aligned(body.defensiveViewYaw(), body.defensiveViewPitch())
                        && offerRangedGrade(tick, feet)) return;
                body.turnUrgent(rangedRetreat.bearing(), AgentEmergencyFootwork.PITCH);
                status = "checking the next dry retreat bearing";
            }
            case DRIVE -> {
                Vec3d landing = rangedRetreat.landing();
                boolean aimingForShelter = shelterGoal != null && turnDifference(before, yaw(shelterGoal.subtract(feet))) <= 8;
                if (aimingForShelter) {
                    Vec3d axis = Vec3d.fromPolar(0, player.getYaw());
                    double remaining = shelterGoal.subtract(feet).dotProduct(axis);
                    if (remaining > 0.12 && remaining < feet.distanceTo(landing)) landing = feet.add(axis.multiply(remaining));
                }
                body.driveCheckedEmergencyLane(landing, rangedRetreat.bearing(), !aimingForShelter);
                rangedDriveTick = tick;
                status = rangedMovementStatus(aimingForShelter);
            }
            case BRACE -> {
                if (rangedSurveyFrom.squaredDistanceTo(feet) >= 0.64) {
                    rangedSurveyFrom = null;
                    status = "checking retreat bearings from changed footing";
                } else if (tryRangedCover(tick, coverSlot, protectsRoute, spend, true)) return;
                else {
                    body.pauseWork();
                    body.sneak();
                    status = "ranged danger; no usable cover or dry exit witnessed";
                }
            }
        }
    }

    private void preferRangedShelter(int tick, Vec3d feet) {
        if (shelterGoal != null && shelterGoal.squaredDistanceTo(feet) >= 0.04)
            rangedRetreat.prefer(tick, yaw(shelterGoal.subtract(feet)));
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
        rangedRetreat.next(tick);
        return false;
    }

    private boolean stepRangedGrade(int tick) {
        var tread = rangedGrade;
        switch (tread.step(client, body, tick)) {
            case CHECKING, MOVING -> status = "using a witnessed one-block dry tread to retreat";
            case LANDED -> {
                rangedGrade = null;
                rangedSurveyFrom = null;
                status = "landed on a witnessed dry tread; continuing the ranged retreat";
            }
            case REFUSED -> {
                rangedGrade = null;
                rangedRetreat.next(tick);
                return false;
            }
        }
        return true;
    }

    private boolean holdsShelter(Vec3d feet) {
        return shelter != null && shelterState != null && rangedSource != null
            && Vec3d.ofCenter(shelter).squaredDistanceTo(feet) <= 16
            && body.rangedCoverState(shelter) == shelterState
            && blocksShotLine(new Box(shelter), rangedSource, feet, crouchShelter);
    }

    private void clearShelter() {
        shelter = null;
        shelterState = null;
        shelterGoal = null;
        crouchShelter = false;
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
                || turnDifference(yaw(target.subtract(feet)), yaw(feet.subtract(source))) > 110
                || block.expand(0.32, 0, 0.32).raycast(feet.add(0, 1.28, 0), target.add(0, 1.28, 0)).isPresent())
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

    private boolean tryRangedCover(int tick, int slot, Predicate<BlockPos> protectsRoute, Predicate<ItemStack> spend,
                                   boolean ordinary) {
        var player = client.player;
        if (rangedCover != null) {
            if (ordinary) body.sneak();
            Vec3d point = Vec3d.ofCenter(rangedCover);
            BlockHitResult receipt = body.perceive(point, 3).orElse(null);
            if (receipt != null && receipt.getBlockPos().equals(rangedCover)
                    && client.world.getBlockState(receipt.getBlockPos()).isOf(rangedCoverBlock)
                    && player.getInventory().getStack(rangedCoverSlot).getCount() < rangedCoverCount) {
                status = "confirmed a placed block of ranged cover";
                coverReceipt = true;
                if (ordinary) {
                    shelter = rangedCover;
                    shelterState = body.rangedCoverState(shelter);
                    crouchShelter = true;
                    shelterGoal = null;
                    coverReceipt = holdsShelter(player.getPos());
                    if (!coverReceipt) clearShelter();
                    status = coverReceipt ? "placed a solid block across the last witnessed shot line"
                        : "placed a block; the witnessed shot line is not covered";
                }
                rangedCover = null;
                return true;
            } else if (tick < rangedCoverUntil) {
                body.aimUrgent(point);
                status = "waiting for the cover placement to settle";
            } else rangedCover = null;
            return coverReceipt || rangedCover != null;
        }
        if (rangedCoverTried || slot < 0 || !Float.isFinite(rangedYaw)
                || (ordinary ? rangedSource == null || player.hurtTime != 0 : rangedPitch < 0 || rangedPitch > 60)
                || player.getVelocity().horizontalLengthSquared() > 0.0064) return false;
        var direction = Direction.fromHorizontalDegrees(rangedYaw);
        if (Math.abs(MathHelper.wrapDegrees(direction.getPositiveHorizontalDegrees() - rangedYaw)) > 23) return false;
        BlockPos cover = player.getBlockPos().offset(direction);
        if (ordinary && !blocksShotLine(new Box(cover), rangedSource, player.getPos(), true)) {
            cover = cover.up();
            if (!blocksShotLine(new Box(cover), rangedSource, player.getPos(), true)) return false;
        }
        if (protectsRoute.test(cover) || player.getBoundingBox().expand(0.08).intersects(new Box(cover))) return false;
        Vec3d point = Vec3d.ofBottomCenter(cover).add(0, -0.035, 0);
        if (ordinary) {
            if (rangedPlacementBy == 0) rangedPlacementBy = tick + 15;
            if (tick >= rangedPlacementBy) {
                rangedCoverTried = true;
                return false;
            }
        }
        BlockHitResult floor = body.terrain(point, player.getEyePos().distanceTo(point) + 0.08).orElse(null);
        if (floor == null || !floor.getBlockPos().equals(cover.down()) || floor.getSide() != Direction.UP
                || Math.abs(floor.getPos().y - cover.getY()) > 0.05
                || body.dryRouteClear(Vec3d.ofCenter(cover)) != AgentBody.DryRouteSample.CLEAR) {
            if (!ordinary || body.renderedAim(point, 7)) return false;
            body.aimUrgent(point);
            status = "checking for a supported cover placement with a carried block";
            return true;
        }
        var support = client.world.getBlockState(floor.getBlockPos());
        if (support.isOf(Blocks.MAGMA_BLOCK) || !support.getFluidState().isEmpty()
                || ordinary && AgentBody.dryCaveDanger(support)
                || !Block.isShapeFullCube(support.getCollisionShape(client.world, floor.getBlockPos()))) return false;
        ItemStack selected = player.getMainHandStack();
        boolean equipped = coverMaterial(selected) && (spend == null || spend.test(selected));
        if (!equipped) selectRangedSlot(slot, tick);
        if (ordinary) body.sneak();
        status = "aiming at a witnessed face for ranged cover";
        var preparation = !equipped ? AgentBody.Preparation.EQUIPMENT
            : player.isSneaking() && (!ordinary || body.canPlaceStationAcross(floor))
                ? AgentBody.Preparation.READY : AgentBody.Preparation.STANCE;
        if (body.useContact(floor, AgentBody.Contact.PLACE, preparation)) {
            rangedCoverTried = true;
            rangedCover = cover;
            rangedCoverBlock = ((BlockItem) selected.getItem()).getBlock();
            rangedCoverUntil = tick + 10;
            rangedCoverSlot = player.getInventory().selectedSlot;
            rangedCoverCount = player.getMainHandStack().getCount();
            status = ordinary ? "requesting one supported block across the witnessed shot line"
                : "placing one block between the ledge and ranged fire";
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
