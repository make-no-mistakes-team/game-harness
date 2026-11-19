package io.gameharness.pilot;

import java.util.Arrays;
import java.util.function.Consumer;
import java.util.function.Predicate;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
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

/** Bounded excursions from the mine, with the same rendered observations and inputs as tunnel work. */
final class PilotCaves {
    private static final double REACH = 3.9;
    private static final int SURVEY_TICKS = 42;
    private static final int MAX_DROP = 12;
    private static final Predicate<ItemStack> TORCH = stack -> stack.isOf(Items.TORCH);
    private static final Predicate<ItemStack> WATER = stack -> stack.isOf(Items.WATER_BUCKET);
    private static final Predicate<ItemStack> BUCKET = stack -> stack.isOf(Items.BUCKET);
    private static final Predicate<ItemStack> BOAT = stack -> stack.isIn(ItemTags.BOATS);
    private static final Predicate<ItemStack> BLOCK = stack -> stack.isOf(Items.COBBLESTONE)
        || stack.isOf(Items.COBBLED_DEEPSLATE) || stack.isOf(Items.DIRT) || stack.isIn(ItemTags.PLANKS);
    private static final int FLOOR = 1, SHIN = 2, HEAD = 4, LEFT = 8, RIGHT = 16, RETURN = 32;
    private static final int WALKABLE = FLOOR | SHIN | HEAD | LEFT | RIGHT | RETURN;

    private enum Phase {
        SURVEY, DRIVE, LOOK_DOWN, FILL, POUR, RECLAIM, DESCEND, ASCEND, CENTER, PLACE, CUT, LIGHT, BOAT_VIEW
    }
    private record WaterLink(BlockPos lip, BlockPos source, BlockPos bottom, BlockPos shore,
                             Direction approach, Direction flank) {}
    private record TorchTarget(BlockHitResult support, Vec3d aim, boolean lip) {}

    private final MinecraftClient client;
    private final PilotBody body;
    private final PilotHands hands;
    private final PilotTools tools;
    private final Consumer<BlockPos> traveled;
    private final BlockPos[] quietLips = new BlockPos[8];
    private final int[] quietUntil = new int[quietLips.length];
    private final BlockPos[] visited = new BlockPos[9];
    private final int[] proof = new int[3];
    private final BlockHitResult[] dimFloors = new BlockHitResult[proof.length];
    private TorchTarget torchTarget;
    private ClientWorld world;
    private ClientPlayerEntity player;
    private String status = "surveying for a cave opening";
    private BlockPos origin, stance, destination;
    private Direction opening, bearing, travel;
    private Phase phase;
    private int since, phaseSince, option, steps, quietCursor, cutSide, cutIndex, cuts, placed;
    private int cooldown, nextLight, lastAction, before, waterProof;
    private boolean entered, needSurvey, triedHigh, triedLight, triedPlace, triedWater, earlyHigh, centerForBearing;
    private boolean afloat, leavingWater, checkedLipLight;
    private BlockHitResult ore, lava, face, fill;
    private WaterLink plannedWater, waterLink;
    private BlockPos highBottom, boatFloor;
    private float boatYaw;
    private BlockPos replayTo;
    private int replaySince, replayProof;
    private boolean replayWater;

    PilotCaves(MinecraftClient client, PilotBody body, PilotHands hands, PilotTools tools,
               Consumer<BlockPos> traveled) {
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.tools = tools;
        this.traveled = traveled;
    }

    boolean active() { return origin != null; }
    boolean entered() { return entered; }
    String status() { return status; }
    BlockHitResult ore() { return ore; }
    BlockHitResult lava() { return lava; }
    BlockPos boatFloor() { return boatFloor; }
    float boatYaw() { return boatYaw; }

    void interruptLight(int tick) {
        if (torchTarget != null) resumeAfterLight(tick);
    }

    /** A null ore predicate prospects for exposed lava; a null planned foot can only continue an excursion. */
    boolean step(int tick, BlockPos planned, Direction direction, Predicate<BlockState> preferredOre) {
        resetOnWorldChange();
        ore = lava = null;
        boatFloor = null;
        if (player == null || world == null) return false;
        if (!active()) {
            if (planned == null || direction == null || tick < cooldown || !player.isOnGround()
                || player.isTouchingWater() || quiet(player.getBlockPos(), tick)) return false;
            stance = player.getBlockPos();
            if (!aperture(planned, direction)) return false;
            origin = stance;
            opening = direction;
            entered = false;
            since = tick;
            steps = cuts = placed = 0;
            visited[0] = stance;
            startSurvey(tick);
            status = "cave opening: lit clearance beyond the mine and a visible rock boundary";
            return true;
        }
        boolean inTransit = phase == Phase.DESCEND || phase == Phase.ASCEND || phase == Phase.DRIVE
            || phase == Phase.CENTER;
        boolean peeking = phase == Phase.POUR || phase == Phase.RECLAIM || phase == Phase.LOOK_DOWN
            || phase == Phase.LIGHT && torchTarget != null && torchTarget.lip
            || phase == Phase.SURVEY && option == 0;
        if (!inTransit
            && (!player.isOnGround() || player.isTouchingWater()
                || !(player.getBlockPos().equals(stance) || peeking && atLip(stance)))) {
            return finish(tick, "leaving cave survey after losing dry footing");
        }
        // A forward survey may straddle the lip, but it must not dispatch a
        // ninth landing into the eight-footing visit history.
        if (phase == Phase.SURVEY && steps == visited.length - 1
            || !inTransit && !peeking && tick - since > 620) {
            return finish(tick, "ending the cave survey; keeping traveled supports");
        }
        return switch (phase) {
            case SURVEY -> survey(tick, preferredOre);
            case DRIVE -> drive(tick);
            case LOOK_DOWN -> lookDown(tick);
            case FILL -> fill(tick);
            case POUR -> pour(tick);
            case RECLAIM -> reclaim(tick);
            case DESCEND -> descend(tick);
            case ASCEND -> recoverWater(tick);
            case CENTER -> center(tick);
            case PLACE -> place(tick);
            case CUT -> cut(tick);
            case LIGHT -> light(tick);
            case BOAT_VIEW -> offerBoatFloor(tick);
        };
    }

    private void resetOnWorldChange() {
        if (world == client.world && player == client.player) return;
        world = client.world;
        player = client.player;
        origin = replayTo = null;
        torchTarget = null;
        waterLink = null;
        entered = false;
        cooldown = nextLight = 0;
        Arrays.fill(quietLips, null);
    }

    private boolean aperture(BlockPos planned, Direction direction) {
        BlockPos mouth = stance.offset(direction);
        if (planned.getX() != mouth.getX() || planned.getZ() != mouth.getZ()) return false;
        Vec3d opening = Vec3d.ofCenter(mouth.up(), 0.27);
        Vec3d far = Vec3d.ofCenter(mouth.offset(direction, 3).up(), 0.27);
        if (!body.clearTerrain(opening) || !body.clearTerrain(far)) return false;
        Direction side = direction.rotateYClockwise();
        Vec3d left = offset(far, side, -1.12), right = offset(far, side, 1.12);
        Vec3d up = far.add(0, 1.18, 0), down = far.add(0, -1.55, 0);
        // The rays must leave the tunnel's one-wide, two-high envelope.
        boolean drop = body.clearTerrain(down);
        if (!(drop || body.clearTerrain(left) || body.clearTerrain(right) || body.clearTerrain(up))) return false;

        // A roof must overhang the interior lane, not the mouth or the near side of a cliff.
        Vec3d interior = offset(far, direction, 4);
        if (roof(up, mouth, direction)
            || roof(interior.add(0, 1.7, 0), mouth, direction)
            || roof(interior.add(0, 2.5, 0), mouth, direction)
            || roof(interior.add(0, 3.6, 0), mouth, direction)) return true;

        // Open-air ravines still qualify when the downward passage has opposing rock walls.
        if (!drop) return false;
        BlockHitResult a = ravineWall(down, mouth, direction, side.getOpposite());
        if (a == null) return false;
        BlockHitResult b = ravineWall(down, mouth, direction, side);
        return b != null && Math.abs(along(a.getPos().subtract(b.getPos()), direction)) <= 3.5;
    }

    private boolean roof(Vec3d through, BlockPos mouth, Direction direction) {
        // The lit collision face can witness the roof; a dangling vine outline cannot.
        BlockHitResult hit = body.terrain(through, 15).orElse(null);
        if (hit == null || hit.getSide() != Direction.DOWN || !natural(state(hit))) return false;
        Vec3d inside = hit.getPos().subtract(Vec3d.ofBottomCenter(mouth));
        return inside.y > 2.0 && along(inside, direction) >= 1.65
            && Math.abs(along(inside, direction.rotateYClockwise())) <= 0.8;
    }

    private BlockHitResult ravineWall(Vec3d down, BlockPos mouth, Direction direction, Direction flank) {
        Vec3d base = Vec3d.ofBottomCenter(mouth);
        for (int width = 2; width <= 6; width += 2) {
            Vec3d point = offset(offset(down, direction, 2), flank, width);
            BlockHitResult hit = body.terrain(point, 15).orElse(null);
            if (hit == null || hit.getSide() != flank.getOpposite() || !natural(state(hit))) continue;
            Vec3d inside = hit.getPos().subtract(base);
            if (along(inside, direction) >= 1.65 && along(inside, flank) >= 1.25) return hit;
        }
        return null;
    }

    private static double along(Vec3d point, Direction direction) {
        return point.x * direction.getOffsetX() + point.z * direction.getOffsetZ();
    }

    private void startSurvey(int tick) {
        bearing = opening;
        option = 0;
        needSurvey = true;
        triedHigh = triedLight = triedPlace = triedWater = false;
        earlyHigh = centerForBearing = checkedLipLight = false;
        cutSide = 0;
        highBottom = null;
        start(Phase.SURVEY, tick);
    }

    private boolean survey(int tick, Predicate<BlockState> preferredOre) {
        int age = tick - phaseSince;
        if (needSurvey && (option == 0 || age >= 12)) {
            needSurvey = false;
            if (preferredOre == null) {
                lava = body.visibleFluid(true, true, 14);
                if (lava != null) return finish(tick, "cave survey: witnessed exposed lava source");
            } else {
                BlockHitResult exposed = body.find(preferredOre, 12).orElse(null);
                if (exposed != null && !exposed.getBlockPos().equals(stance.down())) {
                    if (player.getEyePos().squaredDistanceTo(exposed.getPos()) <= REACH * REACH) {
                        ore = exposed;
                        return finish(tick, "cave survey: exposed ore in reach");
                    }
                    if (option == 0) bearing = direction(exposed.getPos().subtract(player.getPos()));
                }
            }
        }
        if (option >= 4) {
            if (!triedHigh) {
                triedHigh = true;
                start(Phase.LOOK_DOWN, tick);
            } else {
                return alternatives(tick);
            }
            return true;
        }
        travel = switch (option) {
            case 0 -> bearing;
            case 1 -> bearing.rotateYClockwise();
            case 2 -> bearing.rotateYCounterclockwise();
            default -> bearing.getOpposite();
        };
        status = "checking lit cave ledges for a walkable step";
        BlockPos ahead = stance.offset(travel);
        look(Vec3d.ofBottomCenter(ahead), age < 12 ? -28 : age < 23 ? 13 : 61);
        // Floor and headroom often come into frame at different pitches; proofs are local to this stance.
        for (int i = 0; i < proof.length; i++) {
            BlockPos foot = ahead.up(i - 1);
            if (seen(foot)) continue;
            proof[i] = checkStep(foot, travel, proof[i]);
            if (proof[i] == WALKABLE) {
                BlockHitResult dimFloor = dimFloors[i];
                if (dimFloor != null && !triedLight && tick >= nextLight && hands.count(TORCH) > 2) {
                    return lightTarget(dimFloor, floorAim(foot, travel), false, tick);
                }
                return driveTo(foot, tick);
            }
        }
        if (option == 0 && age >= 34 && age <= SURVEY_TICKS && !checkedLipLight && !triedLight && tick >= nextLight
            && hands.count(TORCH) > 2 && atLip(stance)) {
            checkedLipLight = true;
            BlockHitResult support = body.find(PilotCaves::solid, 2.9, this::dimLipFace).orElse(null);
            if (support != null) {
                return lightTarget(support, support.getPos().lerp(Vec3d.ofCenter(support.getBlockPos()), 0.04),
                    true, tick);
            }
        }
        if (age >= 28 && option == 0 && (proof[0] & FLOOR) == 0) creep(ahead);
        if (age >= SURVEY_TICKS) {
            if (option == 0 && !triedHigh && hands.count(BOAT) > 0) {
                // Check a forward descent before walking back onto the launch deck.
                earlyHigh = triedHigh = true;
                start(Phase.LOOK_DOWN, tick);
            } else {
                nextBearing(tick);
            }
        }
        return true;
    }

    private void nextBearing(int tick) {
        if (!player.getBlockPos().equals(stance) && atLip(stance)) {
            centerForBearing = true;
            start(Phase.CENTER, tick);
            return;
        }
        option++;
        needSurvey = option < 4;
        start(Phase.SURVEY, tick);
    }

    private boolean dimLipFace(BlockHitResult hit) {
        Direction side = hit.getSide();
        if (side == Direction.DOWN || body.observedFaceLight(hit) > 6) return false;
        BlockPos support = hit.getBlockPos();
        if (side == Direction.UP && support.equals(stance.down())) return true;
        int height = support.getY() + side.getOffsetY() - stance.getY();
        double x = hit.getPos().x - stance.getX() - 0.5;
        double z = hit.getPos().z - stance.getZ() - 0.5;
        return height >= -1 && height <= 2 && Math.abs(x) <= 1.6 && Math.abs(z) <= 1.6
            && x * bearing.getOffsetX() + z * bearing.getOffsetZ() >= -0.25;
    }

    private boolean lightTarget(BlockHitResult support, Vec3d aim, boolean lip, int tick) {
        torchTarget = new TorchTarget(support, aim, lip);
        before = hands.count(TORCH);
        triedLight = true;
        start(Phase.LIGHT, tick);
        return true;
    }

    private int checkStep(BlockPos foot, Direction travel, int mask) {
        Vec3d base = Vec3d.ofBottomCenter(foot);
        Direction side = travel.rotateYClockwise();
        if ((mask & FLOOR) == 0) {
            BlockHitResult floor = floorHit(foot, travel, false);
            if (floor != null) {
                mask |= FLOOR;
                if (phase == Phase.SURVEY && body.observedFaceLight(floor) <= 6) {
                    dimFloors[foot.getY() - stance.getY() + 1] = floor;
                }
            }
        }
        if ((mask & SHIN) == 0 && body.clearTerrain(base.add(0, 0.18, 0))) mask |= SHIN;
        if ((mask & HEAD) == 0 && body.clearTerrain(base.add(0, 1.82, 0))) mask |= HEAD;
        Vec3d mid = base.add(0, 0.95, 0);
        if ((mask & LEFT) == 0 && body.clearTerrain(offset(mid, side, -0.30))) mask |= LEFT;
        if ((mask & RIGHT) == 0 && body.clearTerrain(offset(mid, side, 0.30))) mask |= RIGHT;
        double rise = foot.getY() - stance.getY();
        if (rise == 0 || (mask & RETURN) == 0 && body.clearTerrain(rise < 0
            ? base.add(0, 2.20, 0) : offset(Vec3d.ofBottomCenter(stance).add(0, 2.20, 0), travel, 0.38))) {
            mask |= RETURN;
        }
        return mask;
    }

    private boolean floor(BlockPos foot, Direction approach) {
        return floor(foot, approach, false);
    }

    private boolean floor(BlockPos foot, Direction approach, boolean throughWater) {
        return floorHit(foot, approach, throughWater) != null;
    }

    private BlockHitResult floorHit(BlockPos foot, Direction approach, boolean throughWater) {
        Vec3d point = floorAim(foot, approach);
        BlockHitResult hit = throughWater
            ? body.terrainThroughWater(point, player.getEyePos().distanceTo(point) + 0.12).orElse(null)
            : terrain(point);
        return hit != null && hit.getBlockPos().equals(foot.down()) && hit.getSide() == Direction.UP
            && Math.abs(hit.getPos().y - foot.getY()) < 0.06 && solid(state(hit)) ? hit : null;
    }

    private static Vec3d floorAim(BlockPos foot, Direction approach) {
        return offset(Vec3d.ofBottomCenter(foot), approach, 0.34).add(0, -0.035, 0);
    }

    private boolean waterFloor(WaterLink link) {
        return floor(link.bottom, link.approach, true) && floor(link.shore, link.approach, true);
    }

    private boolean driveTo(BlockPos foot, int tick) {
        destination = foot;
        start(Phase.DRIVE, tick);
        return true;
    }

    private boolean drive(int tick) {
        if (arrived(destination)) return reached(tick, destination);
        if (tick - phaseSince > 43 || player.isTouchingWater()
            || player.getY() < Math.min(stance.getY(), destination.getY()) - 0.2) {
            return finish(tick, "cave step did not reach the witnessed support");
        }
        Vec3d target = Vec3d.ofBottomCenter(destination);
        boolean up = destination.getY() > stance.getY();
        status = up ? "climbing a verified cave step" : "walking onto a verified cave ledge";
        move(target, up ? 4 : 38, up);
        return true;
    }

    private boolean reached(int tick, BlockPos foot) {
        stance = foot;
        traveled.accept(foot);
        visited[++steps] = foot;
        entered = true;
        startSurvey(tick);
        status = "reached cave footing and recorded the way back";
        return true;
    }

    private boolean lookDown(int tick) {
        BlockPos shaft = stance.offset(opening);
        look(Vec3d.ofBottomCenter(shaft), 69);
        status = "crouching at the cave lip to check for a lit floor below";
        if (body.hazardAhead(yaw(Vec3d.ofBottomCenter(shaft)), 2.1))
            return finish(tick, "cave lip rejected: visible lava in the descent lane");
        creep(shaft);
        for (int drop = 2; highBottom == null && drop <= MAX_DROP; drop++) {
            BlockPos foot = shaft.down(drop);
            if (floor(foot, opening)) highBottom = foot;
        }
        if (highBottom != null && waterLink == null && !triedWater && !world.getDimension().ultrawarm()) {
            BlockPos shore = highBottom.offset(opening).up();
            BlockPos source = shaft.down();
            // The shore must be above the water's bottom block so the player can leave the column.
            if (floor(shore, opening) && body.clearTerrain(Vec3d.ofCenter(shore, 0.30))
                && body.clearTerrain(Vec3d.ofCenter(shore.up(), 0.76))
                && body.clearTerrain(Vec3d.ofCenter(source))) {
                BlockHitResult support = attachment(source, opening);
                if (support != null) {
                    Direction flank = support.getSide().getAxis() == opening.getAxis()
                        ? opening.rotateYClockwise() : support.getSide();
                    plannedWater = new WaterLink(stance, source, highBottom, shore, opening, flank);
                    if (hands.count(WATER) != 0) {
                        face = support;
                        triedWater = true;
                        before = hands.count(WATER);
                        waterProof = 0;
                        start(Phase.POUR, tick);
                        return true;
                    }
                    if (hands.count(BUCKET) != 0) {
                        fill = body.visibleFluid(false, true, REACH);
                        if (fill != null) {
                            triedWater = true;
                            before = hands.count(WATER);
                            start(Phase.FILL, tick);
                            return true;
                        }
                    }
                }
            }
        }
        return tick - phaseSince < 40 || alternatives(tick);
    }

    private boolean alternatives(int tick) {
        if (!player.getBlockPos().equals(stance) && atLip(stance)) {
            start(Phase.CENTER, tick);
            return true;
        }
        if (earlyHigh) {
            earlyHigh = false;
            if (highBottom != null && stance.getY() - highBottom.getY() >= 4 && hands.count(BOAT) > 0) {
                start(Phase.BOAT_VIEW, tick);
            } else {
                nextBearing(tick);
            }
            return true;
        }
        if (!triedLight && hands.count(TORCH) > 0 && tick >= nextLight) {
            triedLight = true;
            before = hands.count(TORCH);
            start(Phase.LIGHT, tick);
            return true;
        }
        if (highBottom != null && !triedPlace && placed < 3 && hands.count(BLOCK) > 0) {
            triedPlace = true;
            travel = opening;
            destination = stance.offset(travel).down();
            start(Phase.PLACE, tick);
            return true;
        }
        while (highBottom != null && cuts < 3 && cutSide < 2) {
            travel = cutSide++ == 0 ? opening.rotateYClockwise() : opening.rotateYCounterclockwise();
            destination = stance.offset(travel).down();
            if (!seen(destination)) {
                cutIndex = 2;
                start(Phase.CUT, tick);
                return true;
            }
        }
        if (highBottom != null && stance.getY() - highBottom.getY() >= 4 && hands.count(BOAT) > 0) {
            start(Phase.BOAT_VIEW, tick);
            return true;
        }
        return finish(tick, highBottom == null ? "cave lip deferred: no lit, reachable landing"
            : "cave lip deferred: lit floor below, but no verified descent or return route");
    }

    /** A witnessed floor is a candidate, not a license to launch. The boat controller must prove its path. */
    private boolean offerBoatFloor(int tick) {
        status = "checking the natural floor below for a possible boat route";
        int age = tick - phaseSince;
        Vec3d center = Vec3d.ofBottomCenter(stance);
        if (horizontalSquared(center) > 0.28 * 0.28) {
            if (age >= 40) return finish(tick, "cave lip deferred: could not center on dry support for the boat check");
            crouchToward(center, 48);
            return true;
        }
        BlockPos farther = highBottom.offset(opening);
        look(Vec3d.ofBottomCenter(farther), 68);
        body.sneak();
        BlockHitResult hit = floorHit(farther, opening, false);
        if (hit == null || !natural(state(hit))) hit = floorHit(highBottom, opening, false);
        if (hit != null && natural(state(hit))) {
            boatFloor = hit.getBlockPos().up();
            boatYaw = MathHelper.wrapDegrees(opening.getPositiveHorizontalDegrees());
            return finish(tick, "cave lip: witnessed a lower floor for a boat safety check");
        }
        return age < 58 || finish(tick, "cave lip deferred: no verified descent or return route");
    }

    private boolean center(int tick) {
        status = "returning to the dry center of the cave lip";
        if (arrived(stance)) {
            if (!centerForBearing) return alternatives(tick);
            centerForBearing = false;
            nextBearing(tick);
            return true;
        }
        if (!atLip(stance) || tick - phaseSince > 32)
            return finish(tick, "could not recenter on the last dry cave support");
        crouchToward(Vec3d.ofBottomCenter(stance), 48);
        return true;
    }

    private boolean light(int tick) {
        status = "placing light on a witnessed face before advancing";
        TorchTarget target = torchTarget;
        if (target != null && target.lip) body.sneak();
        if (lastAction != 0 && hands.count(TORCH) < before) {
            resumeAfterLight(tick);
            if (target == null || !target.lip) {
                option = 0;
                needSurvey = true;
                triedHigh = false;
            } else {
                status = "cave lip torch placed; rechecking the same bearing";
            }
            return true;
        }
        int age = tick - phaseSince;
        if (target != null) {
            status = target.lip ? "lighting the witnessed dim cave lip before rechecking footing"
                : "lighting the dim cave ledge before stepping onto it";
            if (age >= (target.lip ? 26 : 45) || lastAction != 0 && tick - lastAction >= 7) {
                resumeAfterLight(tick);
                return true;
            }
            if (lastAction != 0) return true;
            body.aim(target.aim);
            if ((target.lip && !player.isSneaking()) || !body.aligned(target.aim) || !hands.equipForUse(TORCH)) {
                return true;
            }
            BlockHitResult hit = target.lip ? observe(target.aim) : terrain(target.aim);
            if (matches(target.support, hit) && matches(hit, body.selectedFace()) && solid(state(hit))
                && (!target.lip || dimLipFace(hit))) {
                body.use(hit.getBlockPos(), hit.getSide());
                lastAction = tick;
            }
            return true;
        }
        if (age >= 56) return alternatives(tick);
        if (lastAction != 0 && tick - lastAction < 8) return true;
        Direction wall = switch (age / 14) {
            case 0 -> opening.rotateYClockwise();
            case 1 -> opening.rotateYCounterclockwise();
            case 2 -> opening.getOpposite();
            default -> opening;
        };
        Vec3d wallAim = Vec3d.ofCenter(stance.offset(wall), age >= 42 ? -0.18 : 0.52);
        body.aim(wallAim);
        if (!body.aligned(wallAim) || !hands.equipForUse(TORCH)) return true;
        BlockHitResult shown = body.selectedFace();
        if (shown == null || shown.getSide() == Direction.DOWN
            || shown.getPos().squaredDistanceTo(player.getEyePos()) > 2.9 * 2.9
            || shown.getBlockPos().offset(shown.getSide()).equals(stance)) return true;
        body.use(shown.getBlockPos(), shown.getSide());
        lastAction = tick;
        return true;
    }

    private void resumeAfterLight(int tick) {
        torchTarget = null;
        nextLight = tick + 95;
        start(Phase.SURVEY, tick);
    }

    private boolean place(int tick) {
        status = "building a lower step against a visible cave wall";
        if (tick - phaseSince >= 54) return alternatives(tick);
        if (lastAction != 0) {
            if (hands.count(BLOCK) < before) {
                look(Vec3d.ofBottomCenter(destination), tick - lastAction < 14 ? 30 : 66);
                proof[0] = checkStep(destination, travel, proof[0]);
                if (proof[0] == WALKABLE) {
                    placed++;
                    return driveTo(destination, tick);
                }
                return true;
            }
            if (tick - lastAction < 8) return true;
            lastAction = 0;
        }
        if (face == null) {
            look(Vec3d.ofBottomCenter(destination), 67);
            creep(stance.offset(travel));
            if (body.clearTerrain(Vec3d.ofCenter(destination.down()))) face = attachment(destination.down(), travel);
        }
        if (face != null && useFace(face, BLOCK)) {
            before = hands.count(BLOCK);
            lastAction = tick;
        }
        return true;
    }

    private boolean cut(int tick) {
        status = "cutting a short switchback in the visible cave sidewall";
        if (tick - phaseSince > 105) return alternatives(tick);
        if (cutIndex < 0) {
            look(Vec3d.ofBottomCenter(destination), (proof[0] & (HEAD | RETURN)) == (HEAD | RETURN) ? 60 : 17);
            proof[0] = checkStep(destination, travel, proof[0]);
            if (proof[0] == WALKABLE) {
                cuts++;
                return driveTo(destination, tick);
            }
            creep(stance.offset(travel));
            return true;
        }
        BlockPos cell = destination.up(cutIndex);
        Vec3d point = offset(Vec3d.ofCenter(cell), travel, cutIndex == 0 ? 0.16 : 0);
        body.aim(point);
        if (!body.aligned(point)) return true;
        if (body.clearTerrain(point)) {
            cutIndex--;
            return true;
        }
        BlockHitResult hit = observe(point);
        if (hit == null) return true;
        if (cutIndex == 0 && hit.getBlockPos().equals(stance.down()) && hit.getSide() == Direction.UP) {
            creep(stance.offset(travel));
            return true;
        }
        if (!hit.getBlockPos().equals(cell) || !natural(state(hit))) return alternatives(tick);
        if (tools.readyFor(state(hit))) body.mine(cell);
        return true;
    }

    private boolean fill(int tick) {
        status = "filling a bucket from a reachable, visible water source";
        if (hands.count(WATER) > before) {
            triedWater = false;
            start(Phase.LOOK_DOWN, tick);
            return true;
        }
        if (tick - phaseSince >= 42) return alternatives(tick);
        body.aim(fill.getPos());
        BlockHitResult hit = observe(fill.getPos());
        if ((lastAction == 0 || tick - lastAction >= 7) && body.aligned(fill.getPos())
            && hit != null && hit.getBlockPos().equals(fill.getBlockPos())
            && state(hit).getFluidState().isIn(FluidTags.WATER) && hands.equipForUse(BUCKET)) {
            body.useWaterSource(hit.getBlockPos());
            lastAction = tick;
        }
        return true;
    }

    private boolean pour(int tick) {
        status = "pouring water from the dry lip before committing to the drop";
        if (tick - phaseSince >= 70) {
            if (hands.count(WATER) < before && hands.count(BUCKET) > 0) {
                start(Phase.RECLAIM, tick);
                return true;
            }
            return alternatives(tick);
        }
        if (hands.count(WATER) >= before) {
            if ((lastAction == 0 || tick - lastAction >= 8) && useFace(face, WATER)) lastAction = tick;
            return true;
        }
        WaterLink link = plannedWater;
        status = "waiting to see water from the source to the previously observed cave floor";
        body.sneak();
        if ((waterProof & 6) != 6 && tick - lastAction < 27 && peekColumn(link)) return true;
        look(Vec3d.ofBottomCenter(link.source), 72);
        waterProof = observeColumn(link, waterProof);
        if (waterProof == 7 && waterFloor(link)
            && !body.hazardAhead(yaw(Vec3d.ofBottomCenter(link.source)), 2.1)) {
            afloat = leavingWater = false;
            start(Phase.DESCEND, tick);
        }
        return true;
    }

    private boolean reclaim(int tick) {
        status = "recovering the source after rejecting an unverified waterfall";
        if (hands.count(WATER) >= before || tick - phaseSince >= 36) return alternatives(tick);
        BlockPos source = plannedWater.source;
        Vec3d point = offset(Vec3d.ofCenter(source, 0.62), plannedWater.approach, -0.25);
        body.aim(point);
        if ((lastAction == 0 || tick - lastAction >= 8) && body.aligned(point)
            && waterHit(source, point, true) && hands.equipForUse(BUCKET)) {
            body.useWaterSource(source);
            lastAction = tick;
        }
        return true;
    }

    private int observeColumn(WaterLink link, int mask) {
        int middle = (link.source.getY() + link.bottom.getY()) >> 1;
        if ((mask & 1) == 0 && waterAt(link.source, link.approach, link.flank, true)) mask |= 1;
        if ((mask & 2) == 0 && waterAt(link.source.down(link.source.getY() - middle), link.approach, link.flank, false))
            mask |= 2;
        if ((mask & 4) == 0 && waterAt(link.bottom, link.approach, link.flank, false)) mask |= 4;
        return mask;
    }

    private boolean descend(int tick) {
        WaterLink link = plannedWater;
        if (arrived(link.shore) && !player.isTouchingWater()) {
            waterLink = link;
            return reached(tick, link.shore);
        }
        if (tick - phaseSince >= 145 && player.isTouchingWater()
            && player.getY() >= link.bottom.getY() - 0.2) {
            start(Phase.ASCEND, tick);
            return true;
        }
        if (tick - phaseSince >= 145 || player.getY() < link.bottom.getY() - 0.3) {
            return finish(tick, "water route interrupted before reaching the witnessed shore");
        }
        status = "swimming down the witnessed water column to the cave shore";
        if (!afloat && player.isTouchingWater()) afloat = true;
        if (!afloat && player.isOnGround() && !waterAt(link.source, link.approach, link.flank, true)) {
            look(Vec3d.ofBottomCenter(link.source), 64);
            return true;
        }
        descendWater(link);
        return true;
    }

    private boolean recoverWater(int tick) {
        WaterLink link = plannedWater;
        if (arrived(link.lip)) return finish(tick, "returned up the water column after failing to reach shore");
        if (tick - phaseSince >= 145)
            return finish(tick, "could not rejoin the mine from the waterfall");
        status = "swimming back up after failing to reach the cave shore";
        ascendWater(link);
        return true;
    }

    /** Replay the one non-adjacent edge; the ordinary trail stays grounded and records no fictitious steps. */
    boolean followWater(BlockPos from, BlockPos to, int tick) {
        resetOnWorldChange();
        if (waterLink == null || from == null || to == null) return false;
        WaterLink link = waterLink;
        boolean up = link.lip.equals(to) && link.shore.equals(from);
        if (!up && !(link.shore.equals(to) && link.lip.equals(from))) return false;
        if (!to.equals(replayTo) || tick - replaySince > 145) {
            if (to.equals(replayTo) && tick - replaySince <= 200) {
                if (!up && !arrived(link.lip) && atLip(link.lip) && tick - replaySince <= 175) {
                    status = "returning to the dry lip after the waterfall failed revalidation";
                    crouchToward(Vec3d.ofBottomCenter(link.lip), 48);
                    return true;
                }
                return false;
            }
            replayTo = to;
            replaySince = tick;
            replayProof = 0;
            replayWater = leavingWater = false;
        }
        if (arrived(to)) {
            replayTo = null;
            return false;
        }
        status = up ? "climbing the witnessed water column to the mine"
            : "rejoining the cave by the witnessed water column";
        if (player.isTouchingWater()) replayWater = true;
        BlockPos entrance = up ? link.bottom.up() : link.source;
        Direction approach = up ? link.approach.getOpposite() : link.approach;
        Vec3d column = Vec3d.ofBottomCenter(entrance);
        if (!replayWater && player.isOnGround()) {
            if (!up && replayProof != 7 && tick - replaySince < 28 && peekColumn(link)) return true;
            look(column, up ? 57 : 72);
            if (up ? !waterAt(entrance, approach, link.flank, false)
                : (replayProof = observeColumn(link, replayProof)) != 7 || !waterFloor(link)) return true;
        }
        if (!up) {
            descendWater(link);
        } else ascendWater(link);
        return true;
    }

    private void ascendWater(WaterLink link) {
        if (player.getY() >= link.lip.getY() - 0.67) {
            Vec3d lip = Vec3d.ofBottomCenter(link.lip);
            look(lip, 38);
            if (floor(link.lip, link.approach.getOpposite(), true)) move(lip, 38, true);
            else body.jump();
        } else {
            body.jump();
            move(Vec3d.ofBottomCenter(link.source), -26, false);
        }
    }

    private void descendWater(WaterLink link) {
        if (player.getY() <= link.bottom.getY() + 0.55 && player.isTouchingWater()) leavingWater = true;
        if (leavingWater) {
            move(Vec3d.ofBottomCenter(link.shore), 4, true);
        } else {
            body.swimDown();
            move(Vec3d.ofBottomCenter(link.source), 56, false);
        }
    }

    private boolean waterAt(BlockPos cell, Direction from, Direction flank, boolean source) {
        Vec3d center = Vec3d.ofCenter(cell, 0.37);
        return waterHit(cell, offset(center, from, -0.46), source)
            || waterHit(cell, offset(center, flank, 0.46), source);
    }

    private boolean waterHit(BlockPos cell, Vec3d point, boolean source) {
        BlockHitResult hit = terrain(point);
        if (hit == null || !hit.getBlockPos().equals(cell)) return false;
        var fluid = state(hit).getFluidState();
        return fluid.isIn(FluidTags.WATER) && (!source || fluid.isStill());
    }

    private BlockHitResult attachment(BlockPos destination, Direction forward) {
        for (int i = 0; i < 3; i++) {
            Direction side = i == 0 ? forward.rotateYClockwise()
                : i == 1 ? forward.rotateYCounterclockwise() : forward.getOpposite();
            BlockPos neighbor = destination.offset(side);
            BlockHitResult hit = observe(Vec3d.ofCenter(neighbor));
            if (hit != null && hit.getBlockPos().equals(neighbor) && hit.getSide() == side.getOpposite()
                && solid(state(hit))) return hit;
        }
        return null;
    }

    private boolean useFace(BlockHitResult face, Predicate<ItemStack> item) {
        if (face == null) return false;
        Vec3d point = face.getPos().lerp(Vec3d.ofCenter(face.getBlockPos()), 0.04);
        body.aim(point);
        if (!body.aligned(point) || !hands.equipForUse(item)) return false;
        BlockHitResult observed = observe(point), selected = body.selectedFace();
        if (!matches(face, observed) || !matches(face, selected) || !solid(state(observed))) return false;
        body.sneak();
        body.use(face.getBlockPos(), face.getSide());
        return true;
    }

    private static boolean matches(BlockHitResult a, BlockHitResult b) {
        return b != null && a.getBlockPos().equals(b.getBlockPos()) && a.getSide() == b.getSide();
    }

    private void start(Phase phase, int tick) {
        this.phase = phase;
        phaseSince = tick;
        lastAction = 0;
        Arrays.fill(dimFloors, null);
        Arrays.fill(proof, 0);
        if (phase == Phase.PLACE) face = null;
    }

    private boolean finish(int tick, String reason) {
        torchTarget = null;
        status = reason;
        quietLips[quietCursor] = origin;
        quietUntil[quietCursor] = tick + 420;
        quietCursor = (quietCursor + 1) % quietLips.length;
        origin = null;
        cooldown = tick + (entered ? 18 : 45);
        return false;
    }

    private boolean quiet(BlockPos foot, int tick) {
        for (int i = 0; i < quietLips.length; i++) {
            if (tick < quietUntil[i] && foot.equals(quietLips[i])) return true;
        }
        return false;
    }

    private boolean seen(BlockPos foot) {
        for (int i = 0; i <= steps; i++) if (foot.equals(visited[i])) return true;
        return false;
    }

    private boolean arrived(BlockPos foot) {
        return player.isOnGround() && player.getBlockPos().equals(foot)
            && horizontalSquared(Vec3d.ofBottomCenter(foot)) <= 0.27;
    }

    private boolean atLip(BlockPos lip) {
        return player.isOnGround() && !player.isTouchingWater()
            && Math.abs(player.getY() - lip.getY()) < 0.05
            && Math.abs(player.getX() - lip.getX() - 0.5) <= 0.72
            && Math.abs(player.getZ() - lip.getZ() - 0.5) <= 0.72;
    }

    /** Peek past the transparent column onto its side, while the body still overlaps the old dry support. */
    private boolean peekColumn(WaterLink link) {
        Vec3d corner = offset(offset(Vec3d.ofBottomCenter(link.lip), link.approach, 0.61), link.flank, 0.56);
        if (!atLip(link.lip) || horizontalSquared(corner) < 0.055 * 0.055) return false;
        crouchToward(corner, 65);
        return true;
    }

    private void crouchToward(Vec3d target, float pitch) {
        body.sneak();
        if (alignedYaw(look(target, pitch), 7)) body.walk(false);
    }

    private void creep(BlockPos toward) {
        Vec3d target = Vec3d.ofBottomCenter(toward);
        if (atLip(stance) && horizontalSquared(target) > 0.46 * 0.46 && alignedYaw(yaw(target), 7)) {
            body.sneak();
            if (player.isSneaking()) body.walk(false);
        }
    }

    private void move(Vec3d target, float pitch, boolean jump) {
        if (horizontalSquared(target) <= 0.14 * 0.14) return;
        float yaw = look(target, pitch);
        if (alignedYaw(yaw, 7) && !body.hazardAhead(yaw, 1.45)) {
            if (jump) body.jump();
            body.walkDown(false);
        }
    }

    private float look(Vec3d target, float pitch) {
        float yaw = yaw(target);
        body.turn(yaw, pitch);
        return yaw;
    }

    private boolean alignedYaw(float yaw, float tolerance) {
        return Math.abs(MathHelper.wrapDegrees(player.getYaw() - yaw)) <= tolerance;
    }

    private float yaw(Vec3d target) {
        return (float) Math.toDegrees(MathHelper.atan2(player.getX() - target.x, target.z - player.getZ()));
    }

    private double horizontalSquared(Vec3d target) {
        double dx = player.getX() - target.x, dz = player.getZ() - target.z;
        return dx * dx + dz * dz;
    }

    private BlockHitResult observe(Vec3d point) {
        return body.perceive(point, Math.min(REACH, player.getEyePos().distanceTo(point) + 0.14)).orElse(null);
    }

    private BlockHitResult terrain(Vec3d point) {
        return body.terrain(point, player.getEyePos().distanceTo(point) + 0.12).orElse(null);
    }

    private BlockState state(BlockHitResult hit) {
        return world.getBlockState(hit.getBlockPos());
    }

    private static boolean solid(BlockState state) {
        return state.getFluidState().isEmpty() && (natural(state) || state.isOf(Blocks.COBBLESTONE)
            || state.isOf(Blocks.COBBLED_DEEPSLATE) || state.isOf(Blocks.DIRT) || state.isOf(Blocks.GRASS_BLOCK)
            || state.isIn(BlockTags.PLANKS));
    }

    private static boolean natural(BlockState state) {
        return state.isIn(BlockTags.BASE_STONE_OVERWORLD) || state.isIn(BlockTags.BASE_STONE_NETHER)
            || state.isOf(Blocks.CALCITE) || state.isOf(Blocks.DRIPSTONE_BLOCK)
            || state.isOf(Blocks.MOSS_BLOCK) || state.isOf(Blocks.CLAY)
            || state.isIn(BlockTags.IRON_ORES) || state.isIn(BlockTags.COAL_ORES) || state.isIn(BlockTags.DIAMOND_ORES)
            || state.isIn(BlockTags.GOLD_ORES) || state.isIn(BlockTags.COPPER_ORES) || state.isIn(BlockTags.REDSTONE_ORES)
            || state.isIn(BlockTags.LAPIS_ORES) || state.isIn(BlockTags.EMERALD_ORES);
    }

    private static Vec3d offset(Vec3d point, Direction direction, double amount) {
        return point.add(direction.getOffsetX() * amount, 0, direction.getOffsetZ() * amount);
    }

    private static Direction direction(Vec3d delta) {
        if (Math.abs(delta.x) > Math.abs(delta.z)) return delta.x > 0 ? Direction.EAST : Direction.WEST;
        return delta.z > 0 ? Direction.SOUTH : Direction.NORTH;
    }
}
