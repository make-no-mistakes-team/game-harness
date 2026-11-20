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
    private boolean coverReceipt;
    private float rangedYaw, rangedPitch;
    private long rangedUntil;
    private int rangedSelectAfter;
    private BlockPos rangedCover;
    private Block rangedCoverBlock;
    private int rangedCoverUntil, rangedCoverSlot, rangedCoverCount;
    private final MeleeRecovery melee = new MeleeRecovery();
    private Vec3d meleeStart, meleeSurveyFrom;
    private LivingEntity meleeVisible;
    private float meleeAway = Float.NaN;
    private float meleeLane = Float.NaN;
    private int meleeTurn, meleeTurnSince, meleeSamples;
    private long meleeSound;
    private boolean meleeFreshHit, meleeDirectionalEvidence;
    private float meleeLookPitch;
    private String meleeRefusal;
    private Vec3d meleeDriveFrom;
    private int meleeDriveTick;
    private float meleeDriveYaw;
    private boolean meleeDriveConfirmed;
    private double meleeMotionBefore;

    /** Holds the safety lane across missing frames, but not indefinitely without new evidence. */
    static final class MeleeRecovery {
        private static final int QUIET_AFTER_HIT = 32;
        private static final int EVIDENCE_LIMIT = 64;
        private int lastEvidence = -EVIDENCE_LIMIT;
        private int lastHit = -QUIET_AFTER_HIT;
        private boolean active;

        static boolean canSprint(double seen, double speed, int hunger, boolean sprinting) {
            return hunger > 6 && seen >= Math.max(sprinting ? 2.1 : 2.5, 1.4 + 3.2 * speed);
        }

        boolean observe(int tick, boolean hurt, boolean close, boolean separated) {
            if (hurt) lastHit = tick;
            if (hurt || close) lastEvidence = tick;
            active = hurt || close || active && tick - lastEvidence < EVIDENCE_LIMIT
                && (!separated || tick - lastHit < QUIET_AFTER_HIT);
            return active;
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

    boolean observeMelee(AgentEars ears, LivingEntity visible, boolean hurt, boolean healingMeal, int tick) {
        var player = client.player;
        meleeVisible = visible;
        if (player.hasVehicle() || player.isTouchingWater()) {
            melee.active = false;
            return false;
        }
        Vec3d feet = player.getPos();
        double distance = visible == null ? Double.POSITIVE_INFINITY : player.squaredDistanceTo(visible);
        boolean closeMelee = distance <= 5.0 * 5.0
            && (visible instanceof ZombieEntity || !(visible instanceof RangedAttackMob) && distance <= 3.4 * 3.4);
        boolean weakKit = (hurt || closeMelee) && meleeOutmatched();
        boolean wounded = criticallyHurt(player) || healingMeal;
        boolean equippedDuel = closeMelee && !weakKit && !wounded;
        var cue = ears.recentMeleeCue();
        boolean newSound = cue != null && cue.heardAt() != meleeSound;
        boolean hearClose = newSound && cue.near() && client.currentScreen == null
            && System.nanoTime() - cue.heardAt() <= 550_000_000L && (melee.active || wounded || meleeOutmatched());
        if (newSound) meleeSound = cue.heardAt();
        boolean hit = hurt && !equippedDuel;
        meleeFreshHit = hit;
        boolean close = closeMelee && (weakKit || wounded) || hearClose;
        boolean separated = meleeStart != null && feet.squaredDistanceTo(meleeStart) >= 5 * 5
            && distance >= 6 * 6 && body.hasRecentView();
        boolean started = !melee.active;
        if (!melee.observe(tick, hit, close, separated)) return false;
        if (started) {
            meleeStart = feet;
            meleeAway = Float.NaN;
            meleeDirectionalEvidence = false;
            meleeDriveFrom = null;
            meleeDriveConfirmed = false;
            resetMeleeSurvey(feet, tick);
        }
        float away = Float.NaN;
        if (closeMelee) {
            away = yaw(feet.subtract(visible.getPos()));
        } else if (hit) {
            Vec3d impulse = player.getVelocity();
            if (impulse.horizontalLengthSquared() >= 0.0144) away = yaw(impulse);
            else if (cue != null) away = cue.yaw() + 180;
        } else if (hearClose && !Float.isFinite(meleeAway)) {
            away = cue.yaw() + 180;
        }
        if (Float.isFinite(away) && (!meleeDirectionalEvidence
                || hit && !Float.isFinite(meleeLane) && meleeSamples == 0 && meleeTurn == 0
                    && turnDifference(away, meleeAway) >= 100)) {
            meleeAway = away;
            meleeDirectionalEvidence = true;
            resetMeleeSurvey(feet, tick);
        }
        if (!Float.isFinite(meleeAway)) {
            Vec3d walked = body.recentEmergencyFooting();
            meleeAway = walked == null ? player.getYaw() : yaw(walked.subtract(feet));
        }
        return true;
    }

    private boolean meleeOutmatched() {
        var player = client.player;
        int weapon = bestWeapon(PlayerInventory.HOTBAR_SIZE, true);
        if (weapon < 0) return true; // A shield without a weapon is still not a duel kit.
        if (SHIELD.test(player.getOffHandStack()) || SHIELD.test(player.getMainHandStack()) || player.getArmor() >= 4)
            return false;
        ItemStack stack = player.getInventory().getStack(weapon);
        return stack.isOf(Items.WOODEN_AXE) || stack.isOf(Items.WOODEN_SWORD) || player.getHealth() <= 10;
    }

    boolean meleeActive() { return melee.active; }

    void meleeStep(int tick, Predicate<BlockState> dangerous) {
        markDanger(tick);
        forgetContact();
        body.prioritizeMovement();
        var player = client.player;
        meleeStatus("holding after damage or close contact");
        if (player.isTouchingWater() || player.hasVehicle() || client.currentScreen != null) return;
        Vec3d feet = player.getPos();
        if (meleeDriveFrom != null && tick == meleeDriveTick + 1 && client.options.forwardKey.isPressed()
                && !client.options.forwardKey.isUnbound() && !meleeFreshHit && player.isOnGround()
                && player.hurtTime == 0
                && feet.subtract(meleeDriveFrom).dotProduct(Vec3d.fromPolar(0, meleeDriveYaw))
                    > Math.max(0, meleeMotionBefore) + 0.035) {
            meleeDriveConfirmed = true;
        }
        if (player.isOnGround() && feet.squaredDistanceTo(meleeSurveyFrom) >= 1.4 * 1.4) {
            meleeSurveyFrom = feet;
            meleeTurn = 0;
            meleeTurnSince = tick;
            meleeSamples = 0;
        }
        if (meleeTurn < MELEE_ESCAPE_TURNS.length || Float.isFinite(meleeLane)) {
            float facing = player.getYaw();
            Vec3d known = body.recentEmergencyFooting();
            float knownYaw = known == null ? Float.NaN : yaw(known.subtract(feet));
            float bearing = Float.isFinite(meleeLane) ? meleeLane
                : turnDifference(knownYaw, meleeAway) <= 92 && meleeTurn == 0 ? knownYaw
                : meleeAway + MELEE_ESCAPE_TURNS[Math.min(meleeTurn, MELEE_ESCAPE_TURNS.length - 1)];
            body.turnUrgent(bearing, meleeLookPitch);
            if (!player.isOnGround()) {
                meleeStatus("holding after damage or close contact; lining up dry footing in the air");
                return;
            }
            if (turnDifference(facing, bearing) <= 8 && Math.abs(player.getPitch() - meleeLookPitch) <= 11
                    && body.hasRecentView()) {
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
                if (openHandSpaceStrike()) {
                    meleeStatus("lining up a close defensive punch; " + meleeRefusal);
                    return;
                }
                meleeStatus("checking dry retreat footing; " + meleeRefusal);
            } else {
                if (tick - meleeTurnSince >= 30 && body.hasRecentView()) nextMeleeView(tick);
                meleeStatus(body.hasRecentView() ? "aligning the retreat view" : "waiting for a rendered retreat view");
            }
            return;
        }
        // No path was witnessed. Do not run blindly, back over an edge, or open inventory.
        body.sneak();
        LivingEntity threat = meleeVisible;
        if (threat != null && body.hasRecentView() && body.threatPoint() != null) {
            body.aimUrgent(body.threatPoint());
            ItemStack main = player.getMainHandStack();
            if (SHIELD.test(main) || SHIELD.test(player.getOffHandStack()) && AgentBody.shieldSafeMainHand(main)) {
                body.blockAgainst(threat);
            } else if ((main.isEmpty() || main.isIn(ItemTags.SWORDS) || main.isIn(ItemTags.AXES))
                    && body.strikeTarget(threat) && player.getAttackCooldownProgress(0.5f) >= 0.9f) {
                body.strike(threat);
                meleeStatus("lining up a close defensive strike from a stationary stance");
                return;
            } else {
                int weapon = bestWeapon(PlayerInventory.HOTBAR_SIZE, true);
                if (weapon >= 0) selectRangedSlot(weapon, tick);
            }
        } else {
            float toward = meleeAway + 180;
            body.turnUrgent(toward, 17);
            body.guardRangedBearing(toward);
        }
        meleeStatus("bracing; no safe dry retreat witnessed"
            + (meleeRefusal == null ? "" : "; " + meleeRefusal));
    }

    private void meleeStatus(String action) {
        status = (meleeFreshHit ? "melee emergency (fresh damage): " : "melee emergency: ") + action;
    }

    private boolean openHandSpaceStrike() {
        var player = client.player;
        if (meleeVisible == null || !player.getMainHandStack().isEmpty()
                || SHIELD.test(player.getOffHandStack()) || !body.strikeTarget(meleeVisible)
                || player.getAttackCooldownProgress(0.5f) < 0.9f) return false;
        body.strike(meleeVisible);
        return true;
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
    }

    private static float turnDifference(float a, float b) {
        return Math.abs(MathHelper.wrapDegrees(a - b));
    }

    boolean rangedActive() { return rangedUntil != 0 && System.nanoTime() - rangedUntil < 0; }

    boolean observeRanged(AgentEars ears, LivingEntity visible, boolean hurt) {
        var cue = ears.takeFreshRangedCue();
        boolean active = rangedActive();
        Vec3d seen = hurt && visible instanceof RangedAttackMob
                && (visible.isHolding(Items.BOW) || visible.isHolding(Items.CROSSBOW)) ? body.threatPoint() : null;
        if (cue == null && seen == null) {
            if (active && hurt) rangedUnderFire = true;
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
        rangedUntil = System.nanoTime() + RANGED_ALERT_NANOS;
        return true;
    }

    boolean rangedStep(int tick, Predicate<BlockPos> protectsRoute, Predicate<ItemStack> spend) {
        coverReceipt = false;
        markDanger(tick);
        forgetContact();
        body.prioritizeMovement();
        var player = client.player;
        status = rangedAudible ? "bracing after a nearby skeleton shot" : "bracing after damage near a visible archer";
        // The fall controller has already had priority. Never add a movement key to the impulse.
        if (!player.isOnGround() || player.isTouchingWater() || player.hasVehicle() || client.currentScreen != null)
            return false;
        body.sneak();
        body.turnUrgent(rangedYaw, MathHelper.clamp(rangedPitch, -55, 65));
        ItemStack main = player.getMainHandStack();
        boolean offhand = SHIELD.test(player.getOffHandStack()) && canWear(player.getOffHandStack(), spend);
        if (SHIELD.test(main) && canWear(main, spend) || offhand && AgentBody.shieldSafeMainHand(main)
                && !(main.isIn(ItemTags.AXES) && body.shieldStartWouldUseBlock())) {
            body.guardRangedBearing(rangedYaw);
            if (player.isBlocking() && SHIELD.test(player.getActiveItem())) status = "blocking toward ranged fire";
            return false;
        }
        if (player.isUsingItem() || !body.hasRecentView()) return false;
        var inventory = player.getInventory();
        int safeHand = -1, coverSlot = -1;
        boolean heldBack = SHIELD.test(player.getOffHandStack()) && !offhand;
        for (int slot = 0; slot < PlayerInventory.HOTBAR_SIZE; slot++) {
            if (slot != inventory.selectedSlot && client.options.hotbarKeys[slot].isUnbound()) continue;
            ItemStack stack = inventory.getStack(slot);
            if (SHIELD.test(stack)) {
                if (canWear(stack, spend)) {
                    safeHand = slot;
                    break;
                }
                heldBack = true;
            }
            if (offhand && safeHand < 0 && (stack.isEmpty() || stack.isIn(ItemTags.SWORDS)
                    || stack.isIn(ItemTags.PICKAXES))) safeHand = slot;
            if (coverMaterial(stack)) {
                if (spend != null && !spend.test(stack)) heldBack = true;
                else if (coverSlot < 0 || slot == inventory.selectedSlot) coverSlot = slot;
            }
        }
        if (safeHand >= 0) {
            selectRangedSlot(safeHand, tick);
            return false;
        }
        boolean cover = !offhand && rangedUnderFire && tryRangedCover(tick, coverSlot, protectsRoute, spend);
        return heldBack && !cover;
    }

    float rangedRetreatYaw() { return rangedYaw + 180; }
    boolean confirmedCover() { return coverReceipt; }

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
            } else if (tick < rangedCoverUntil) {
                body.aimUrgent(point);
                status = "waiting for the cover placement to settle";
            } else rangedCover = null;
            return coverReceipt || rangedCover != null;
        }
        // A single low block can only intercept a shot arriving from level or below.
        if (rangedCoverTried || slot < 0 || rangedPitch < 0 || rangedPitch > 60
                || player.getVelocity().horizontalLengthSquared() > 0.0064) return false;
        var direction = Direction.fromHorizontalDegrees(rangedYaw);
        if (Math.abs(MathHelper.wrapDegrees(direction.getPositiveHorizontalDegrees() - rangedYaw)) > 23) return false;
        BlockPos cover = player.getBlockPos().offset(direction);
        if (protectsRoute.test(cover) || player.getBoundingBox().expand(0.08).intersects(new Box(cover))) return false;
        Vec3d point = Vec3d.ofBottomCenter(cover).add(0, -0.035, 0);
        BlockHitResult floor = body.terrain(point, player.getEyePos().distanceTo(point) + 0.08).orElse(null);
        if (floor == null || !floor.getBlockPos().equals(cover.down()) || floor.getSide() != Direction.UP
                || Math.abs(floor.getPos().y - cover.getY()) > 0.05
                || body.dryRouteClear(Vec3d.ofCenter(cover)) != AgentBody.DryRouteSample.CLEAR) return false;
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

    private static boolean coverMaterial(ItemStack stack) {
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
        return distance > 2.65 * 2.65 && (threat instanceof RangedAttackMob || !mainShield && !offhand
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
