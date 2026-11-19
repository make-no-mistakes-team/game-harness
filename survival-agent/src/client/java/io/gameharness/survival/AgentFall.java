package io.gameharness.survival;

import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.entity.vehicle.AbstractBoatEntity;
import net.minecraft.item.BoatItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.World;

/** Emergency bucket use and an optional surveyed, already-mounted boat descent. */
final class AgentFall {
    private static final double MAX_SIGHT = 23.0;
    private static final double SAFE_FALL = 3.0;
    private static final int VERIFY_TICKS = 8;
    private static final int MIN_BOAT_DROP = 4;
    private static final int MAX_BOAT_DROP = 12;
    private static final double[] SIDES = {-1.07, 0, 1.07};
    private static final double[] DECK = {-1.44, -0.77, 0, 0.76, 1.34};
    private static final double[] LANDING = {-0.16, 0.78, 1.91};
    private static final double[] SHAFT = {0, 0.52, 1};
    private static final Predicate<ItemStack> BOAT = item -> item.getItem() instanceof BoatItem
        && item.isIn(ItemTags.BOATS) && !item.isIn(ItemTags.CHEST_BOATS);

    private enum Water { NONE, AIM, CONTACT, RECLAIM }
    private enum Boat { NONE, LIP, LANDING, SHAFT, DECK, REPOSITION, PLACE, BOARD, ROW, SETTLE, DISEMBARK }

    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentHands hands;
    private ClientPlayerEntity player;
    private ClientWorld world;
    private int tick;
    private String status = "fall skills idle";

    private Water water = Water.NONE;
    private int waterSince;
    private int waterSlot = -1;
    private int lastHotbar = -10;
    private int waterGround = -1;
    private int waterAttempts;
    private int waterSuccesses;
    private double apex = Double.NaN;
    private BlockPos source;
    private boolean waterSeen, wetLanding, reclaimed;
    private float waterHealth, waterAbsorption;
    private int waterHurt;

    private Boat boatPhase = Boat.NONE;
    private int boatSince;
    private int boatRetry;
    private int boatAttempts;
    private int boatSuccesses;
    private BlockPos boatLanding, lastRejected;
    private Direction boatDirection;
    private Vec3d launch, landing, edge, boatExit;
    private AbstractBoatEntity boat;
    private boolean boarded, dropped, boatDamaged, boatCounted;
    private long proof;
    private int boatSlot;
    private int stable;
    private float boatHealth, boatAbsorption;
    private int boatHurt;

    AgentFall(MinecraftClient client, AgentBody body, AgentHands hands) {
        this.client = client;
        this.body = body;
        this.hands = hands;
    }

    String status() { return status; }
    int waterAttempts() { return waterAttempts; }
    int waterSuccesses() { return waterSuccesses; }
    int boatAttempts() { return boatAttempts; }
    int boatSuccesses() { return boatSuccesses; }

    /** Called after body.begin(), after danger priority and before routine progression. */
    boolean step(Predicate<ItemStack> spend) {
        if (client.player != player || client.world != world) {
            player = client.player;
            world = client.world;
            water = Water.NONE;
            boatPhase = Boat.NONE;
            boat = null;
            source = lastRejected = null;
            apex = Double.NaN;
            boatRetry = 0;
            status = "fall skills idle";
            body.stopFallAim();
        }
        int previous = tick;
        tick = body.actionTick();
        if (player == null || world == null || !player.isAlive() || client.isPaused()) return false;
        if (tick - previous > 1) {
            // Another priority acted before us. Do not count a landing across a gap
            // in observations or launch on a survey from a stance it could have moved.
            stopWater();
            if (boatPhase != Boat.NONE) {
                if (boat != null && player.getVehicle() == boat) {
                    boatDamaged = true;
                    if (boatPhase == Boat.ROW && !dropped) nextBoat(Boat.SETTLE);
                } else if (boatPhase != Boat.DISEMBARK) {
                    finishBoat("boat: interrupted before launch; survey no longer current");
                }
            }
        }
        if (player.isOnGround() || player.isTouchingWater() || player.hasVehicle()) apex = player.getY();
        else if (Double.isFinite(apex)) apex = Math.max(apex, player.getY());
        if (boatPhase != Boat.NONE && boatStep(spend)) return true;
        return waterStep(spend);
    }

    private boolean waterStep(Predicate<ItemStack> spend) {
        if (!world.getRegistryKey().equals(World.OVERWORLD) || world.getDimension().ultrawarm()
            || player.hasVehicle() || player.isInLava() || player.isClimbing()) return stopWater();
        if (water == Water.CONTACT) return checkWaterLanding();
        if (water == Water.RECLAIM) return reclaimWater(spend);
        if (player.isOnGround() || player.isTouchingWater() || client.currentScreen != null || hands.busy())
            return stopWater();

        Vec3d motion = player.getVelocity();
        double fallen = apex - player.getY();
        // Do not take over jumps or short steps; look early in a genuine accelerating fall.
        if (!Double.isFinite(fallen) || motion.y > -0.27 || fallen < 0.42
            || fallen + -motion.y * 4 < SAFE_FALL + 0.32) return stopWater();
        if (water != Water.AIM) {
            var inventory = player.getInventory();
            waterSlot = usable(player.getMainHandStack(), Items.WATER_BUCKET, spend) ? inventory.selectedSlot : -1;
            for (int i = 0; waterSlot < 0 && i < PlayerInventory.HOTBAR_SIZE; i++) {
                if (usable(inventory.getStack(i), Items.WATER_BUCKET, spend) && !client.options.hotbarKeys[i].isUnbound()) {
                    waterSlot = i;
                }
            }
            if (waterSlot < 0) return false;
            water = Water.AIM;
            lastHotbar = tick - 4;
        }
        if (!usable(player.getInventory().getStack(waterSlot), Items.WATER_BUCKET, spend)) return stopWater();
        if (player.getInventory().selectedSlot != waterSlot && tick - lastHotbar >= 4) {
            if (!body.tapHotbar(waterSlot)) return stopWater();
            lastHotbar = tick;
        }

        Vec3d feet = player.getPos();
        double drift = motion.horizontalLengthSquared() > 0.018 ? 3.5 : 1.8;
        Vec3d search = feet.add(motion.x * drift, -6.0, motion.z * drift);
        BlockHitResult hit = body.terrain(search, MAX_SIGHT).orElse(null);
        if (hit == null || !safeTop(hit) || apex - hit.getPos().y <= SAFE_FALL + 0.28) {
            body.aimDuringFall(search);
            status = "falling: checking for a visible dry landing";
            return true;
        }

        double height = hit.getPos().y;
        double gap = feet.y - height;
        BlockPos floor = hit.getBlockPos();
        Vec3d center = Vec3d.ofBottomCenter(floor.up());
        body.aimDuringFall(center);
        status = "falling: lining up the water bucket on witnessed support";
        // Vanilla checks fall distance accumulated before the ground-contact movement.
        if (apex - height <= SAFE_FALL - motion.y + 0.32
            || gap < Math.max(0.85, -motion.y * 1.45 + 0.26)
            || player.getEyePos().squaredDistanceTo(center) > square(player.getBlockInteractionRange())
            || !player.getMainHandStack().isOf(Items.WATER_BUCKET)) return true;

        // Recheck the likely feet at fluid entry and at floor height. Never put water at a
        // distant neighboring block and assume it will spread before this player lands.
        Vec3d contact = forecast(feet, motion, height + 0.85);
        Vec3d impact = forecast(feet, motion, height);
        if (!withinSquare(contact, center, 0.36) || !withinSquare(impact, center, 0.32)
            || !body.clearTerrain(center.add(0, 0.48, 0)) || !footRoom(impact, 0.34)) return true;
        if (!body.tapFallBlock(floor, Items.WATER_BUCKET, center, 0.39)) return true;
        source = floor.up();
        waterAttempts++;
        waterHealth = player.getHealth();
        waterAbsorption = player.getAbsorptionAmount();
        waterHurt = player.hurtTime;
        waterSeen = wetLanding = reclaimed = false;
        waterGround = -1;
        waterSince = tick;
        water = Water.CONTACT;
        status = "used the water bucket in reach; checking contact and landing";
        return true;
    }

    private boolean checkWaterLanding() {
        if (tick - waterSince > 28 || damaged(waterHealth, waterAbsorption, waterHurt)) return stopWater();
        waterHurt = player.hurtTime;
        Vec3d target = Vec3d.ofCenter(source);
        body.aimDuringFall(target);
        BlockHitResult hit = body.perceive(target, player.getEyePos().distanceTo(target) + 0.45).orElse(null);
        if (hit != null && hit.getBlockPos().equals(source)) {
            var fluid = world.getBlockState(hit.getBlockPos()).getFluidState();
            waterSeen |= fluid.isStill() && fluid.isIn(FluidTags.WATER)
                && player.getInventory().getStack(waterSlot).isOf(Items.BUCKET);
        }
        boolean overSource = withinSquare(player.getPos(), target, 0.66) && Math.abs(player.getY() - source.getY()) < 1.1;
        // A single vanilla movement can intersect the water and then the ground.
        if (waterGround < 0 || tick - waterGround <= 1) wetLanding |= overSource && player.isTouchingWater();
        if (!player.isOnGround()) {
            waterGround = -1;
        } else {
            if (!overSource || (!wetLanding && waterGround >= 0 && tick - waterGround > 1)) return stopWater();
            if (waterGround < 0) waterGround = tick;
            if (waterSeen && wetLanding && tick - waterGround >= VERIFY_TICKS) {
                waterSuccesses++;
                water = Water.RECLAIM;
                waterSince = tick;
                status = "water clutch: witnessed water contact and a damage-free landing";
            }
        }
        return true;
    }

    private boolean reclaimWater(Predicate<ItemStack> spend) {
        if (player.getInventory().getStack(waterSlot).isOf(Items.WATER_BUCKET)) return stopWater();
        if (tick - waterSince > 15 || !player.isOnGround()
            || !withinSquare(player.getPos(), Vec3d.ofCenter(source), 0.80)
            || !usable(player.getMainHandStack(), Items.BUCKET, spend)) return stopWater();
        body.aimDuringFall(Vec3d.ofCenter(source));
        if (!reclaimed && body.tapFallSource(source)) reclaimed = true;
        return true;
    }

    private boolean stopWater() {
        if (water != Water.NONE) body.stopFallAim();
        water = Water.NONE;
        return false;
    }

    private static boolean usable(ItemStack stack, Item item, Predicate<ItemStack> spend) {
        return stack.isOf(item) && (spend == null || spend.test(stack));
    }

    /**
     * Accept only an observed lower floor offered by the normal route planner. A single floor
     * sighting starts a stationary survey; it does not authorize launching the boat.
     */
    boolean offerBoat(BlockPos foot, float yaw) {
        if (foot == null || player == null || world == null || boatPhase != Boat.NONE || water != Water.NONE
            || !body.boatControlsAvailable() || hands.busy() || !player.isOnGround() || player.hasVehicle()
            || player.isTouchingWater() || player.isInLava() || world.getDimension().ultrawarm()
            || player.getHealth() < 12 || player.hurtTime > 0 || hands.count(BOAT) == 0
            || foot.equals(lastRejected) && tick < boatRetry) return false;
        if (Math.abs(player.getY() - Math.rint(player.getY())) > 0.04) return false;
        Direction direction = Direction.fromHorizontalDegrees(yaw);
        BlockPos stance = player.getBlockPos();
        int dx = foot.getX() - stance.getX(), dz = foot.getZ() - stance.getZ();
        int horizontal = dx * direction.getOffsetX() + dz * direction.getOffsetZ();
        if (horizontal < 1 || horizontal > 2 || dx * direction.getOffsetZ() - dz * direction.getOffsetX() != 0)
            return false;
        int drop = stance.getY() - foot.getY();
        if (drop < MIN_BOAT_DROP || drop > MAX_BOAT_DROP) return false;
        Vec3d lip = Vec3d.ofBottomCenter(stance);
        Vec3d delta = player.getPos().subtract(lip);
        double ahead = delta.x * direction.getOffsetX() + delta.z * direction.getOffsetZ();
        double across = delta.x * direction.getOffsetZ() - delta.z * direction.getOffsetX();
        if (ahead < -0.44 || ahead > 0.69 || Math.abs(across) > 0.34) return false;
        boatLanding = foot.toImmutable();
        boatDirection = direction;
        edge = along(lip, 0.5, 0);
        launch = along(lip, -1, 0);
        // A farther floor ray witnesses the elevation, not the exact hull touch-down point.
        landing = along(edge, 0.5, 0).add(0, -drop, 0);
        boat = null;
        boarded = dropped = boatDamaged = boatCounted = false;
        stable = 0;
        nextBoat(Boat.LIP);
        body.sneak();
        body.aimFixed(along(landing, 0.83, 0));
        status = "checking whether the lower ledge is broad enough for a boat";
        return true;
    }

    private boolean boatStep(Predicate<ItemStack> spend) {
        if (player.getVehicle() instanceof AbstractBoatEntity mounted && mounted == boat) {
            body.holdBoat(boat);
            if (boatPhase == Boat.BOARD) {
                boatHealth = player.getHealth();
                boatAbsorption = player.getAbsorptionAmount();
                boatHurt = player.hurtTime;
                nextBoat(Boat.ROW);
            }
            return ride();
        }
        if (boatPhase == Boat.DISEMBARK) {
            if (player.isOnGround() && !player.isTouchingWater() && !player.isInLava()
                && Math.abs(player.getY() - boatExit.y) < 0.08 && withinSquare(player.getPos(), boatExit, 0.42)) {
                return finishBoat("boat: standing on the witnessed dismount support");
            }
            if (tick - boatSince > 14) return finishBoat("boat: left the hull; footing needs a new survey");
            return true;
        }
        if (boatPhase == Boat.ROW || boatPhase == Boat.SETTLE || player.hasVehicle())
            return finishBoat("boat: mount lost before a confirmed landing");
        if (!player.isOnGround() || player.isTouchingWater() || player.isInLava()
            || player.getHealth() < 12 || player.hurtTime > 0 || Math.abs(player.getY() - launch.y) > 0.05
            || (client.currentScreen != null && boatPhase != Boat.PLACE)
            || Math.abs(lateral(player.getPos())) > 0.38
            || forward(player.getPos(), edge) < -2.71 || forward(player.getPos(), edge) > 0.23)
            return finishBoat("boat: lost safe takeoff footing");

        switch (boatPhase) {
            case LIP -> {
                body.sneak();
                Vec3d near = along(edge, -0.065, lateral(player.getPos()));
                body.aimFixed(along(near, 0.6, 0).add(0, -0.25, 0));
                if (forward(player.getPos(), edge) >= -0.075) nextBoat(Boat.LANDING);
                else if (player.isSneaking() && floorAt(near)) body.walk(false);
            }
            case LANDING -> {
                body.sneak();
                if (surveyStrip(landing, LANDING, 1.86)) nextBoat(Boat.SHAFT);
            }
            case SHAFT -> {
                body.sneak();
                if (shaft()) nextBoat(Boat.DECK);
            }
            case DECK -> {
                body.sneak();
                if (surveyStrip(launch, DECK, 1.96)) nextBoat(Boat.REPOSITION);
            }
            case REPOSITION -> {
                // Back over the surveyed deck, then place facing out so the hull does not
                // have to turn in a tight space. Vanilla sneak still guards the retreat.
                body.sneak();
                float yaw = boatDirection.getPositiveHorizontalDegrees();
                body.turnFixed(yaw, 39);
                if (forward(player.getPos(), launch) <= -1.0) nextBoat(Boat.PLACE);
                else if (player.isSneaking() && Math.abs(lateral(player.getPos())) <= 0.36
                    && Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw())) <= 2) body.back();
            }
            case PLACE -> {
                status = "boat: equipping it while standing on the witnessed takeoff";
                body.aimFixed(launch);
                Predicate<ItemStack> permitted = spend == null ? BOAT : stack -> BOAT.test(stack) && spend.test(stack);
                if (spend != null && hands.count(permitted) == 0) return finishBoat("boat: all usable boats are reserved");
                if (hands.equipForUse(permitted) && body.tapFallBlock(BlockPos.ofFloored(launch.add(0, -0.03, 0)),
                        player.getMainHandStack().getItem(), launch, 0.17)) {
                    boatSlot = player.getInventory().selectedSlot;
                    nextBoat(Boat.BOARD);
                }
            }
            case BOARD -> {
                status = "boat: waiting for the placed hull and normal boarding";
                if (boat == null && player.getInventory().getStack(boatSlot).isEmpty()) {
                    var visible = body.visibleEntity(entity -> entity instanceof AbstractBoatEntity
                        && entity.getPos().squaredDistanceTo(launch) < 0.13, 4.5).orElse(null);
                    if (visible instanceof AbstractBoatEntity hull
                        && Math.abs(hull.getY() - launch.y) < 0.08 && hull.getFirstPassenger() == null
                        && Math.abs(hull.getVelocity().y) < 0.1
                        && hull.getVelocity().horizontalLengthSquared() < 0.0025) boat = hull;
                }
                if (boat != null) {
                    body.aimFixed(boat.getBoundingBox().getCenter());
                    if (!boarded && body.tapVisibleEntity(boat)) boarded = true;
                }
            }
            default -> throw new IllegalStateException("Unexpected boat phase " + boatPhase);
        }
        if (tick - boatSince > (boatPhase == Boat.PLACE || boatPhase == Boat.REPOSITION ? 95 : 62))
            return finishBoat("boat: could not prove a boat-width takeoff, lane and landing");
        return true;
    }

    private boolean ride() {
        boatDamaged |= damaged(boatHealth, boatAbsorption, boatHurt);
        boatHurt = player.hurtTime;
        if (boatPhase == Boat.ROW) {
            if (!dropped && boat.getY() < launch.y - 0.28 && !boat.isOnGround()) {
                boatAttempts++;
                dropped = true;
            }
            if (dropped) {
                body.aimFixed(along(landing, 0.8, 0));
                status = "descending while actually mounted in the boat";
                if (boat.isOnGround()) nextBoat(Boat.SETTLE);
                return true;
            }
            Vec3d route = along(edge, 2, 0);
            body.aimFixed(route);
            double lateral = lateral(boat.getPos());
            double along = forward(boat.getPos(), edge);
            if (tick - boatSince > 175 || Math.abs(lateral) > 0.36
                || (boat.isOnGround() && (along > 0.91 || boat.getY() < launch.y - 0.15)) || boatDamaged) {
                nextBoat(Boat.SETTLE);
                return true;
            }
            if (boat.isOnGround() && boat.getControllingPassenger() == player) {
                double dx = route.x - boat.getX(), dz = route.z - boat.getZ();
                float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
                body.rowBoat(boat, yaw, true);
            }
            status = "rowing from the witnessed ledge with a confirmed mount";
            return true;
        }
        if (boatPhase == Boat.DISEMBARK) {
            if (tick - boatSince > 7) nextBoat(Boat.SETTLE);
            return true;
        }

        double travel = forward(boat.getPos(), landing);
        boolean bottom = Math.abs(boat.getY() - landing.y) < 0.08 && travel >= -0.22 && travel <= 1.96
            && Math.abs(lateral(boat.getPos())) < 0.63;
        if (boat.isOnGround() && !boat.isInLava() && !boat.isTouchingWater()
            && boat.getVelocity().horizontalLengthSquared() < 0.0009) stable++;
        else stable = 0;
        if (stable >= VERIFY_TICKS && bottom && dropped && !boatDamaged && !boatCounted
            && launch.y - boat.getY() >= MIN_BOAT_DROP - 0.08) {
            boatSuccesses++;
            boatCounted = true;
            status = "boat descent: mounted landing without damage";
        }
        if (stable < VERIFY_TICKS) return true;
        // Choose a currently visible dismount point on real support, not just a clear hull.
        int side = Math.max(0, tick - boatSince - VERIFY_TICKS) / 24 % 3;
        float yaw = boatDirection.getPositiveHorizontalDegrees() + (side == 0 ? 0 : side == 1 ? -90 : 90);
        body.turnFixed(yaw, 37);
        // Vanilla offsets by half the hull's diagonal plus half the passenger width.
        double offset = (boat.getWidth() * Math.sqrt(2) + player.getWidth() + 1e-5) * 0.5;
        double radians = Math.toRadians(player.getYaw());
        double x = -Math.sin(radians), z = Math.cos(radians);
        offset /= Math.max(Math.abs(x), Math.abs(z));
        Vec3d exit = boat.getPos().add(x * offset, 0, z * offset);
        Vec3d floor = new Vec3d(exit.x, Math.rint(boat.getY()), exit.z);
        if (Math.abs(MathHelper.wrapDegrees(player.getYaw() - yaw)) <= 2
            && Math.abs(boat.getY() - floor.y) < 0.08 && floorAt(floor) && footRoom(floor, 0.34)) {
            boatExit = floor;
            body.dismountBoat(boat);
            nextBoat(Boat.DISEMBARK);
        } else if (tick - boatSince > 38) {
            status = "holding the boat: no safe dismount in view";
        }
        return true;
    }

    private boolean surveyStrip(Vec3d origin, double[] lengths, double headroom) {
        Vec3d missing = null;
        long bit = 1L;
        for (double length : lengths) {
            for (double side : SIDES) {
                Vec3d point = along(origin, length, side);
                for (int height = 0; height < 3; height++, bit <<= 1) {
                    if ((proof & bit) != 0) continue;
                    Vec3d sample = point.add(0, height == 1 ? 0.22 : height == 2 ? headroom : 0, 0);
                    if (height == 0 ? floorAt(sample) : body.clearTerrain(sample)) proof |= bit;
                    else if (missing == null) missing = sample;
                }
            }
        }
        if (missing == null) return true;
        body.aimFixed(missing);
        return false;
    }

    private boolean shaft() {
        double span = edge.y + 1.75 - (landing.y + 0.4);
        Vec3d missing = null;
        long bit = 1L;
        for (double height : SHAFT) {
            for (double side : SIDES) {
                for (int depth = 0; depth <= 1; depth++, bit <<= 1) {
                    if ((proof & bit) != 0) continue;
                    Vec3d point = along(edge, 0.85 + depth * 1.4, side).add(0, 1.75 - span * height, 0);
                    if (body.clearTerrain(point)) proof |= bit;
                    else if (missing == null) missing = point;
                }
            }
        }
        if (missing == null) return true;
        body.aimFixed(missing);
        return false;
    }

    private boolean footRoom(Vec3d feet, double halfWidth) {
        for (int side = -1; side <= 1; side += 2) {
            for (int forward = -1; forward <= 1; forward += 2) {
                Vec3d corner = feet.add(side * halfWidth, 0, forward * halfWidth);
                if (!floorAt(corner) || !body.clearTerrain(corner.add(0, 0.22, 0))
                    || !body.clearTerrain(corner.add(0, 1.81, 0))) return false;
            }
        }
        return true;
    }

    private boolean floorAt(Vec3d surface) {
        Vec3d inside = surface.add(0, -0.035, 0);
        var hit = body.terrain(inside, player.getEyePos().distanceTo(inside) + 0.25).orElse(null);
        return hit != null && hit.getBlockPos().equals(BlockPos.ofFloored(inside)) && safeTop(hit);
    }

    private boolean safeTop(BlockHitResult hit) {
        if (hit.getSide() != Direction.UP || Math.abs(hit.getPos().y - hit.getBlockPos().getY() - 1) > 0.015)
            return false;
        var state = world.getBlockState(hit.getBlockPos()); // exact lit ray hit, never a neighboring block read
        Block block = state.getBlock();
        return state.getFluidState().isEmpty() && (state.isIn(BlockTags.BASE_STONE_OVERWORLD)
            || block == Blocks.DIRT || block == Blocks.GRASS_BLOCK || block == Blocks.COARSE_DIRT
            || block == Blocks.ROOTED_DIRT || block == Blocks.COBBLESTONE || block == Blocks.COBBLED_DEEPSLATE
            || block == Blocks.MOSS_BLOCK || block == Blocks.SANDSTONE || block == Blocks.RED_SANDSTONE);
    }

    private boolean damaged(float health, float absorption, int hurt) {
        return player.getHealth() < health || player.getAbsorptionAmount() < absorption || player.hurtTime > hurt;
    }

    private static Vec3d forecast(Vec3d feet, Vec3d motion, double height) {
        double x = feet.x, y = feet.y, z = feet.z, vx = motion.x, vy = motion.y, vz = motion.z;
        for (int i = 0; i < 24 && y > height; i++) {
            double fraction = Math.min(1, (y - height) / -vy);
            x += vx * fraction;
            z += vz * fraction;
            y += vy;
            vx *= 0.91;
            vz *= 0.91;
            vy = (vy - 0.08) * 0.98;
        }
        return new Vec3d(x, height, z);
    }

    private static double square(double value) { return value * value; }
    private static boolean withinSquare(Vec3d a, Vec3d b, double radius) {
        return Math.abs(a.x - b.x) <= radius && Math.abs(a.z - b.z) <= radius;
    }

    private Vec3d along(Vec3d origin, double forward, double side) {
        int x = boatDirection.getOffsetX(), z = boatDirection.getOffsetZ();
        return origin.add(x * forward + z * side, 0, z * forward - x * side);
    }

    private double lateral(Vec3d pos) {
        return (pos.x - edge.x) * boatDirection.getOffsetZ() - (pos.z - edge.z) * boatDirection.getOffsetX();
    }

    private double forward(Vec3d pos, Vec3d origin) {
        return (pos.x - origin.x) * boatDirection.getOffsetX() + (pos.z - origin.z) * boatDirection.getOffsetZ();
    }

    private void nextBoat(Boat next) {
        boatPhase = next;
        boatSince = tick;
        proof = 0;
    }

    private boolean finishBoat(String reason) {
        lastRejected = boatLanding;
        boatRetry = tick + 160;
        boat = null;
        nextBoat(Boat.NONE);
        status = reason;
        return false;
    }
}
