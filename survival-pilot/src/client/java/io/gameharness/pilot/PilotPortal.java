package io.gameharness.pilot;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.World;

/** Builds and enters a portal using observed materials, inventory receipts and vanilla input. */
final class PilotPortal {
    private static final int OBSIDIAN_COUNT = 10;
    private static final double REACH = 4.25;
    private static final double SEARCH = 14;
    private static final Predicate<ItemStack> FLINT = item(Items.FLINT);
    private static final Predicate<ItemStack> GRAVEL_DROPS = stack -> stack.isOf(Items.GRAVEL) || FLINT.test(stack);
    private static final Predicate<ItemStack> OBSIDIAN = item(Items.OBSIDIAN);
    private static final Predicate<ItemStack> PICK = item(Items.DIAMOND_PICKAXE);
    private static final Predicate<ItemStack> STEEL = item(Items.FLINT_AND_STEEL);
    private static final Predicate<ItemStack> WATER_BUCKET = item(Items.WATER_BUCKET);
    private static final Predicate<ItemStack> BUCKET = item(Items.BUCKET);
    private static final Predicate<ItemStack> INGOT = item(Items.IRON_INGOT);
    private static final Predicate<ItemStack> DIAMOND = item(Items.DIAMOND);
    private static final Predicate<ItemStack> GRAVEL = item(Items.GRAVEL);
    private static final Predicate<ItemStack> FILLER = stack -> stack.isOf(Items.COBBLESTONE)
        || stack.isOf(Items.COBBLED_DEEPSLATE) || stack.isOf(Items.DIRT);

    // Corner filler supports the uprights and lets both lintel blocks attach to inward faces.
    // Each lift raises the camera enough to see the next upward face; the pillar isn't in the frame.
    private record FrameBlock(int x, int y, int lift, int supportX, boolean obsidian) {}
    private static final FrameBlock[] FRAME = {
        new FrameBlock(0, 0, 0, 0, false), new FrameBlock(3, 0, 0, 3, false),
        new FrameBlock(1, 0, 0, 1, true), new FrameBlock(2, 0, 0, 2, true),
        new FrameBlock(0, 1, 0, 0, true), new FrameBlock(3, 1, 0, 3, true),
        new FrameBlock(0, 2, 1, 0, true), new FrameBlock(3, 2, 1, 3, true),
        new FrameBlock(0, 3, 2, 0, true), new FrameBlock(3, 3, 2, 3, true),
        new FrameBlock(0, 4, 3, 0, false), new FrameBlock(3, 4, 3, 3, false),
        new FrameBlock(1, 4, 3, 0, true), new FrameBlock(2, 4, 3, 3, true)
    };

    private record Site(BlockPos stand, Direction facing) {
        Direction axis() { return facing.rotateYClockwise(); }
        BlockPos at(int x, int y) {
            return stand.offset(facing, 2).offset(axis(), x - 1).up(y);
        }
    }

    private record Target(BlockPos pos, Vec3d point) {
        Target(BlockHitResult hit) {
            this(hit.getBlockPos(), hit.getPos().lerp(Vec3d.ofCenter(hit.getBlockPos()), 0.035));
        }
    }

    private enum Placement { WAIT, DONE, BLOCKED }
    private enum Phase { SUPPLY, SURVEY, BUILD, LOWER, LIGHT, ENTER }

    private static final class Place {
        final BlockPos support;
        final Direction face;
        final BlockPos dest;
        final Vec3d point;
        final Predicate<ItemStack> item;
        final Block block;
        final int start;
        int used;
        int inventoryBefore;

        Place(BlockPos support, Direction face, Vec3d point, Item item, int start) {
            this.support = support;
            this.face = face;
            this.dest = support.offset(face);
            this.point = point;
            this.item = item(item);
            block = ((BlockItem) item).getBlock();
            this.start = start;
        }
    }

    private final MinecraftClient client;
    private final PilotBody body;
    private final PilotHands hands;
    private final PilotTools tools;
    private final List<Site> rejectedSites = new ArrayList<>();
    private final BlockPos[] rejectedMaterials = new BlockPos[12];
    private final int[] rejectedUntil = new int[rejectedMaterials.length];
    private final List<Vec3d> waterTrail = new ArrayList<>();
    private final Block[] pillar = new Block[3];

    private Phase phase = Phase.SUPPLY;
    private String status = "preparing for the Nether";
    private String failure;
    private boolean won;
    private boolean lit;
    private int tick;
    private int phaseSince;
    private int ignoredIndex;
    private int supplySince;
    private int obsidianSearchSince;
    private int obsidianOwned;
    private Target material;
    private boolean miningGravel;
    private int materialSince;
    private int lastMine;
    private int waitForDrop;
    private Vec3d dropPoint;
    private Place gravel;
    private Target water;
    private Target lava;
    private int fluidSince;
    private int nextFluidUse;
    private int pouredAt;
    private int waterBeforePour;
    private int bucketsBeforePour;
    private int castUntil;
    private Target pouredWater;
    private int reclaimSince;
    private int waterBeforeReclaim;
    private int lavaSearchSince;
    private int trailIndex = -1;
    private BlockHitResult waterSupport;
    private Site site;
    private BlockPos surveyAnchor;
    private Direction surveyBearing;
    private int surveyRotations;
    private int surveyIndex;
    private int surveySince;
    private int siteSearchUntil;
    private int frameIndex;
    private int frameBlocks;
    private int lift;
    private int stanceSince;
    private int lowerSince;
    private int rebuilds;
    private String invalidSite;
    private Place placement;
    private int ignitionUse;

    PilotPortal(MinecraftClient client, PilotBody body, PilotHands hands, PilotTools tools) {
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.tools = tools;
    }

    String status() { return status; }
    String failure() { return failure; }
    boolean won() { return won; }
    int confirmedFrameBlocks() { return frameBlocks; }
    boolean ignited() { return lit; }

    boolean updateArrival() {
        if (!won && lit && phase == Phase.ENTER && client.player != null && client.world != null
                && World.NETHER.equals(client.world.getRegistryKey())) {
            won = true;
            status = "entered the Nether through the built portal";
        }
        return won;
    }

    void step(PilotProgress progress) {
        if (updateArrival() || failure != null || client.player == null || client.world == null) return;
        if (++tick > 28_800 && phase != Phase.LOWER) {
            if (lift == 0) stop("ran out of Nether preparation time");
            else rejectSite("ran out of Nether construction time");
            return;
        }
        switch (phase) {
            case SUPPLY -> supply(progress);
            case SURVEY -> survey(progress);
            case BUILD -> build(progress);
            case LOWER -> lower();
            case LIGHT -> light();
            case ENTER -> enter(progress);
        }
    }

    private void supply(PilotProgress progress) {
        if (tick - supplySince > 14_400) {
            stop(status + " without an inventory receipt");
            return;
        }
        if (!has(PICK, 1)) {
            if (!has(DIAMOND, 3)) {
                stop("need three diamonds to craft a diamond pickaxe");
                return;
            }
            status = "crafting a diamond pickaxe at the workshop";
            progress.portalWorkshop("diamond_pickaxe", 2);
            return;
        }
        int obsidian = hands.count(OBSIDIAN);
        if (obsidian > obsidianOwned) {
            obsidianSearchSince = supplySince = tick;
            material = null;
            waitForDrop = 0;
        }
        obsidianOwned = obsidian;
        if (obsidian < OBSIDIAN_COUNT) {
            gatherObsidian(progress);
            return;
        }
        if (pouredWater != null && reclaimWater()) return;
        if (!has(STEEL, 1)) {
            makeIgnition(progress);
            return;
        }
        if (!has(FILLER, 7)) {
            status = "seeking seven solid blocks for scaffold and corner supports";
            if (!mineForFiller(progress)) progress.portalSearch();
            return;
        }
        material = null;
        changePhase(Phase.SURVEY);
    }

    private Item fillerItem() {
        var inv = client.player.getInventory();
        if (FILLER.test(inv.getMainHandStack())) return inv.getMainHandStack().getItem();
        for (int i = 0; i < PlayerInventory.MAIN_SIZE; ++i) {
            ItemStack stack = inv.getStack(i);
            if (FILLER.test(stack)) return stack.getItem();
        }
        return null;
    }

    private boolean mineForFiller(PilotProgress progress) {
        return mineVisible(progress, state -> state.isOf(Blocks.STONE) || state.isOf(Blocks.DEEPSLATE)
            || state.isOf(Blocks.DIRT) || state.isOf(Blocks.COBBLESTONE) || state.isOf(Blocks.COBBLED_DEEPSLATE),
            FILLER, false, "scaffold blocks");
    }

    private void makeIgnition(PilotProgress progress) {
        if (has(FLINT, 1)) {
            material = null;
            gravel = null;
            if (!has(INGOT, 1)) {
                status = "obtaining one iron ingot for ignition";
                progress.portalIron(1);
                return;
            }
            status = "crafting flint and steel in the inventory";
            hands.craft("flint_and_steel");
            return;
        }
        if (gravel != null) {
            status = "placing recovered gravel for another flint attempt";
            Placement result = place(gravel, false);
            if (result == Placement.DONE) {
                material = new Target(gravel.dest, Vec3d.ofCenter(gravel.dest));
                miningGravel = true;
                materialSince = tick;
                lastMine = 0;
            }
            if (result != Placement.WAIT) gravel = null;
            return;
        }
        if (mineVisible(progress, state -> state.isOf(Blocks.GRAVEL), GRAVEL_DROPS, true, "gravel for flint")) return;
        if (has(GRAVEL, 1) && client.player.isOnGround()) {
            BlockHitResult floor = body.stationFace(null);
            if (floor != null && floor.getSide() == Direction.UP
                    && supportFace(floor.getBlockPos(), Direction.UP, floor.getPos()) != null
                    && !client.player.getBoundingBox().intersects(new Box(floor.getBlockPos().up()))) {
                gravel = new Place(floor.getBlockPos(), Direction.UP, floor.getPos(), Items.GRAVEL, tick);
                return;
            }
        }
        status = "seeking exposed gravel for flint";
        progress.portalSearch();
    }

    private void gatherObsidian(PilotProgress progress) {
        if (pouredWater == null && pouredAt != 0 && waterSupport != null
                && hands.count(BUCKET) > bucketsBeforePour && hands.count(WATER_BUCKET) < waterBeforePour) {
            BlockPos placedSource = waterSupport.getBlockPos().offset(waterSupport.getSide());
            pouredWater = new Target(placedSource, Vec3d.ofCenter(placedSource));
            castUntil = tick + 42;
            reclaimSince = 0;
            pouredAt = 0;
        }
        if (castUntil > tick) {
            status = "letting water flow onto the observed lava";
            if (lava != null) body.aim(lava.point);
            return;
        }
        if (mineVisible(progress, state -> state.isOf(Blocks.OBSIDIAN), OBSIDIAN, false, "obsidian")) return;
        if (pouredWater != null && reclaimWater()) return;
        if (tick - Math.max(obsidianSearchSince, 1) < 125 && lava == null && !has(WATER_BUCKET, 1)) {
            status = "seeking naturally exposed obsidian";
            progress.portalSearch();
            return;
        }
        if (!has(WATER_BUCKET, 1)) {
            lavaSearchSince = 0;
            if (has(BUCKET, 1)) {
                if (lava == null) rememberLava();
                fetchWater(progress);
            } else if (has(INGOT, 3)) {
                status = "crafting a bucket at the workshop";
                progress.portalWorkshop("bucket", 0);
            } else {
                if (lava == null) rememberLava();
                status = "obtaining three iron ingots for a water bucket";
                progress.portalIron(3);
            }
            rememberWaterRoute();
            return;
        }
        if (water != null) {
            water = null;
            fluidSince = tick;
            trailIndex = waterTrail.size() - 1;
        }
        if (lavaSearchSince == 0) lavaSearchSince = tick;
        castWater(progress);
    }

    private boolean mineVisible(PilotProgress progress, Predicate<BlockState> matches, Predicate<ItemStack> drop,
            boolean gravelTarget, String label) {
        if (material == null) {
            if (progress.portalCollect(drop, 7)) {
                status = "collecting visible " + label;
                return true;
            }
            if (tick < waitForDrop) {
                body.aim(dropPoint);
                status = "looking for dropped " + label;
                return true;
            }
            BlockHitResult hit = body.find(matches, SEARCH).orElse(null);
            if (hit == null || ignored(hit.getBlockPos())) return false;
            material = new Target(hit);
            miningGravel = gravelTarget;
            materialSince = tick;
            lastMine = 0;
        } else if (miningGravel != gravelTarget) {
            material = null;
            return false;
        }
        status = "mining " + label;
        if (tick - materialSince > 620) {
            ignore(material.pos);
            material = null;
            return false;
        }
        if (client.player.getEyePos().squaredDistanceTo(material.point) > 3.95 * 3.95) {
            if (progress.portalApproach(material.point)) return true;
            ignore(material.pos);
            material = null;
            return false;
        }
        body.aim(material.point);
        if (!body.aligned(material.point)) return true;
        BlockHitResult crosshair = body.selectedFace();
        if (crosshair != null && crosshair.getBlockPos().equals(material.pos)) {
            // Outline rays see through water; the current crosshair must still agree before mining.
            BlockHitResult hit = body.find(matches, REACH).orElse(null);
            if (hit != null && hit.getBlockPos().equals(material.pos) && tools.readyFor(state(hit))) {
                body.mine(material.pos);
                lastMine = tick;
            }
            return true;
        }
        if (lastMine != 0 && tick - lastMine < 8) {
            dropPoint = Vec3d.ofCenter(material.pos);
            waitForDrop = tick + 30;
        } else {
            ignore(material.pos);
        }
        material = null;
        return true;
    }

    private void rememberLava() {
        BlockHitResult hit = body.visibleFluid(true, true, SEARCH);
        if (hit != null && !ignored(hit.getBlockPos())) {
            lava = new Target(hit);
            fluidSince = tick;
            waterTrail.clear();
            waterTrail.add(client.player.getPos());
        }
    }

    private void rememberWaterRoute() {
        if (lava == null || waterTrail.isEmpty()) return;
        Vec3d feet = client.player.getPos();
        if (feet.squaredDistanceTo(waterTrail.getLast()) <= 2.5 * 2.5) return;
        if (waterTrail.size() >= 128) clearLava();
        else waterTrail.add(feet);
    }

    private void fetchWater(PilotProgress progress) {
        status = "seeking a visible water source";
        if (water == null) {
            BlockHitResult hit = body.visibleFluid(false, true, SEARCH);
            if (hit == null || !waterSource(state(hit)) || ignored(hit.getBlockPos())) {
                progress.portalSearch();
                return;
            }
            water = new Target(hit);
            fluidSince = tick;
        }
        if (tick - fluidSince > 270 || client.player.getEyePos().distanceTo(water.point) > 4
                && !progress.portalApproach(water.point)) {
            ignore(water.pos);
            water = null;
            return;
        }
        if (client.player.getEyePos().distanceTo(water.point) > 4) return;
        status = "filling the bucket from observed source water";
        body.aim(water.point);
        if (tick < nextFluidUse || !body.aligned(water.point) || !hands.equip(BUCKET)) return;
        BlockHitResult hit = observed(water.point);
        if (hit == null || !hit.getBlockPos().equals(water.pos) || !waterSource(state(hit))) {
            ignore(water.pos);
            water = null;
            return;
        }
        body.useWaterSource(water.pos);
        nextFluidUse = tick + 6;
    }

    private void castWater(PilotProgress progress) {
        status = "seeking exposed lava sources";
        if (lava == null) {
            rememberLava();
            if (lava == null) {
                if (tick - lavaSearchSince > 900) progress.portalProspectLava();
                else progress.portalSearch();
                return;
            }
        }
        if (trailIndex >= 0 && trailIndex < waterTrail.size()) {
            Vec3d waypoint = waterTrail.get(trailIndex);
            if (client.player.getPos().squaredDistanceTo(waypoint) < 1.25 * 1.25) {
                if (--trailIndex >= 0) return;
            } else if (!progress.portalApproach(waypoint)) {
                trailIndex = -1;
            } else {
                status = "retracing the traveled route to exposed lava";
                return;
            }
        }
        if (tick - fluidSince > 600) {
            forgetLava();
            return;
        }
        if (client.player.getEyePos().distanceTo(lava.point) > 3.85) {
            if (!progress.portalApproach(lava.point)) forgetLava();
            return;
        }
        if (waterSupport == null) {
            body.aim(lava.point);
            if (!body.aligned(lava.point)) return;
            BlockHitResult source = observed(lava.point);
            if (source == null || !source.getBlockPos().equals(lava.pos) || !lavaSource(state(source))) {
                forgetLava();
                return;
            }
            waterSupport = castingSupport(lava.pos);
            if (waterSupport == null) {
                if (tick - fluidSince > 60) forgetLava();
                return;
            }
        }
        status = "pouring water from shore onto the observed lava";
        BlockPos support = waterSupport.getBlockPos();
        Direction face = waterSupport.getSide();
        body.aim(waterSupport.getPos());
        if (tick >= nextFluidUse && body.aligned(waterSupport.getPos()) && hands.equip(WATER_BUCKET)
                && selected(support, face) && supportFace(support, face, waterSupport.getPos()) != null) {
            body.sneak();
            body.use(support, face);
            pouredAt = tick;
            waterBeforePour = hands.count(WATER_BUCKET);
            bucketsBeforePour = hands.count(BUCKET);
            nextFluidUse = tick + 6;
        }
    }

    private BlockHitResult castingSupport(BlockPos source) {
        if (!client.player.isOnGround() || client.player.isTouchingWater() || client.player.isInLava()) return null;
        for (Direction side : Direction.Type.HORIZONTAL) {
            BlockPos bank = source.offset(side);
            BlockPos wall = bank.up();
            Direction inward = side.getOpposite();
            BlockHitResult hit = supportFace(wall, inward, facePoint(wall, inward));
            if (hit != null && !new Box(source.up()).expand(0.35).intersects(client.player.getBoundingBox())) return hit;
            for (int radius = 1; radius <= 2; ++radius, bank = bank.offset(side)) {
                if (new Box(bank.up()).expand(0.35).intersects(client.player.getBoundingBox())) continue;
                hit = supportFace(bank, Direction.UP, facePoint(bank, Direction.UP));
                if (hit != null) return hit;
            }
        }
        return null;
    }

    private void forgetLava() {
        if (lava != null) ignore(lava.pos);
        clearLava();
    }

    private void clearLava() {
        lava = null;
        waterSupport = null;
        pouredAt = 0;
        trailIndex = -1;
        waterTrail.clear();
    }

    private boolean reclaimWater() {
        if (!has(BUCKET, 1) || (reclaimSince != 0
                && (hands.count(WATER_BUCKET) > waterBeforeReclaim || tick - reclaimSince > 70))
                || client.player.getEyePos().distanceTo(pouredWater.point) > REACH) {
            pouredWater = null;
            clearLava();
            return false;
        }
        if (reclaimSince == 0) {
            reclaimSince = tick;
            waterBeforeReclaim = hands.count(WATER_BUCKET);
        }
        status = "recovering the poured water after cooling lava";
        body.aim(pouredWater.point);
        BlockHitResult hit = observed(pouredWater.point);
        if (tick >= nextFluidUse && hit != null && hit.getBlockPos().equals(pouredWater.pos)
                && waterSource(state(hit)) && body.aligned(pouredWater.point) && hands.equip(BUCKET)) {
            body.useWaterSource(pouredWater.pos);
            nextFluidUse = tick + 6;
        }
        return true;
    }

    private void survey(PilotProgress progress) {
        status = "surveying a level, reachable portal worksite";
        if (tick - phaseSince > 2_400) {
            stop("no reachable level portal worksite");
            return;
        }
        if (site == null) {
            if (tick < siteSearchUntil || !client.player.isOnGround() || client.player.isTouchingWater()) {
                progress.portalSearch();
                return;
            }
            BlockPos feet = client.player.getBlockPos();
            if (!feet.equals(surveyAnchor)) {
                surveyAnchor = feet;
                surveyBearing = client.player.getHorizontalFacing();
                surveyRotations = 0;
            }
            while (surveyRotations < 4 && rejectedSites.contains(new Site(feet, surveyBearing))) {
                advanceSurveyBearing();
            }
            if (surveyRotations == 4) {
                progress.portalSearch();
                return;
            }
            site = new Site(feet, surveyBearing);
            surveyIndex = 0;
            surveySince = tick;
        }
        if (!center(site.stand)) {
            if (tick - surveySince > 65) rejectSurvey();
            return;
        }
        BlockPos check = switch (surveyIndex) {
            case 0 -> site.stand.down();
            case 1 -> site.stand.offset(site.facing).down();
            case 2, 3, 4, 5 -> site.at(surveyIndex - 2, -1);
            case 6 -> site.stand.up(4);
            case 7, 8, 9, 10 -> site.at(surveyIndex - 7, 4);
            case 11 -> site.stand.offset(site.facing).up();
            case 12, 13, 14 -> site.at(1, surveyIndex - 11);
            case 15, 16, 17 -> site.at(2, surveyIndex - 14);
            default -> throw new IllegalStateException("invalid portal survey");
        };
        boolean floor = surveyIndex <= 5;
        Vec3d point = floor ? facePoint(check, Direction.UP) : Vec3d.ofCenter(check);
        body.aim(point);
        if (!body.aligned(point)) {
            if (tick - surveySince > 65) rejectSurvey();
            return;
        }
        if (floor) {
            BlockHitResult hit = supportFace(check, Direction.UP, point);
            if (hit == null || Math.abs(hit.getPos().y - check.getY() - 1) > 0.06) {
                if (tick - surveySince > 30) rejectSurvey();
                return;
            }
        } else {
            BlockHitResult hit = observed(point);
            if (hit != null && client.player.getEyePos().distanceTo(hit.getPos())
                    < client.player.getEyePos().distanceTo(point) + 0.25) {
                rejectSurvey();
                return;
            }
        }
        surveySince = tick;
        if (++surveyIndex <= 17) return;
        frameBlocks = frameIndex = lift = 0;
        ignitionUse = 0;
        stanceSince = tick;
        invalidSite = null;
        changePhase(Phase.BUILD);
    }

    private void rejectSurvey() {
        rejectedSites.add(site);
        site = null;
        advanceSurveyBearing();
    }

    private void advanceSurveyBearing() {
        surveyBearing = surveyBearing.rotateYClockwise();
        ++surveyRotations;
    }

    private void build(PilotProgress progress) {
        if (frameIndex == FRAME.length) {
            lowerSince = tick;
            changePhase(Phase.LOWER);
            return;
        }
        BlockPos stance = site.stand.up(lift);
        if (placement == null && !center(stance)) {
            if (lift == 0 && tick - stanceSince < 65 && client.player.isOnGround()) {
                progress.portalApproach(Vec3d.ofBottomCenter(stance));
            } else if (tick - stanceSince > 65) {
                rejectSite("lost the stable portal work stance");
            }
            return;
        }
        FrameBlock block = FRAME[frameIndex];
        if (block.lift > lift) {
            status = "jump-placing a temporary portal work pillar";
            if (placement == null) {
                BlockPos support = stance.down();
                Item filler = fillerItem();
                if (filler == null) {
                    rejectSite("ran out of blocks for the work pillar");
                    return;
                }
                placement = new Place(support, Direction.UP, facePoint(support, Direction.UP), filler, tick);
                pillar[lift] = placement.block;
            }
            switch (place(placement, true)) {
                case DONE -> {
                    ++lift;
                    stanceSince = tick;
                    placement = null;
                }
                case BLOCKED -> rejectSite("could not raise the work pillar using its visible top face");
                case WAIT -> {}
            }
            return;
        }
        status = "placing portal frame: " + frameBlocks + "/" + OBSIDIAN_COUNT + " obsidian";
        if (placement == null) {
            Direction face = block.supportX == block.x ? Direction.UP
                : block.supportX < block.x ? site.axis() : site.axis().getOpposite();
            BlockPos support = site.at(block.supportX, face == Direction.UP ? block.y - 1 : block.y);
            Vec3d point = facePoint(support, face).add(Vec3d.of(site.facing.getOpposite().getVector()).multiply(0.22));
            Item blockItem = block.obsidian ? Items.OBSIDIAN : fillerItem();
            if (blockItem == null) {
                rejectSite("ran out of blocks for the frame corners");
                return;
            }
            placement = new Place(support, face, point, blockItem, tick);
        }
        switch (place(placement, false)) {
            case DONE -> {
                if (block.obsidian) ++frameBlocks;
                ++frameIndex;
                stanceSince = tick;
                placement = null;
            }
            case BLOCKED -> rejectSite("frame placement lacked a visible face or block receipt");
            case WAIT -> {}
        }
    }

    private Placement place(Place work, boolean jump) {
        if (tick - work.start > 105) return Placement.BLOCKED;
        if (work.used != 0 && hands.count(work.item) < work.inventoryBefore) {
            Vec3d point = jump ? new Vec3d(client.player.getX(), work.dest.getY() + 0.75, client.player.getZ())
                : Vec3d.ofCenter(work.dest);
            body.aim(point);
            BlockHitResult hit = observed(point);
            return hit != null && hit.getBlockPos().equals(work.dest) && state(hit).isOf(work.block)
                ? Placement.DONE : Placement.WAIT;
        }
        Vec3d point = jump ? new Vec3d(client.player.getX(), work.support.getY() + 0.98, client.player.getZ())
            : work.point;
        body.aim(point);
        if (!hands.equip(work.item) || !body.aligned(point)
                || supportFace(work.support, work.face, point) == null || !selected(work.support, work.face)) {
            return Placement.WAIT;
        }
        if (client.player.getBoundingBox().intersects(new Box(work.dest))) {
            if (jump && client.player.isOnGround() && tick - work.used >= 6) body.jump();
            return Placement.WAIT;
        }
        if (tick - work.used >= 6) {
            // Sneak when interacting with blocks that could have their own use action.
            if (!jump) body.sneak();
            work.inventoryBefore = hands.count(work.item);
            work.used = tick;
            body.use(work.support, work.face);
        }
        return Placement.WAIT;
    }

    private void rejectSite(String reason) {
        invalidSite = reason;
        // If a pillar use was consumed before the sight receipt, step down from our own
        // actual height rather than assuming the player is still at the preceding lift.
        if (site != null) {
            int actualLift = (int) Math.floor(client.player.getY() - site.stand.getY() + 0.05);
            if (client.player.isOnGround() && actualLift > lift && actualLift <= 3
                    && client.player.getBlockPos().getX() == site.stand.getX()
                    && client.player.getBlockPos().getZ() == site.stand.getZ()) lift = actualLift;
        }
        placement = null;
        lowerSince = tick;
        changePhase(Phase.LOWER);
    }

    private void lower() {
        if (lift == 0) {
            if (invalidSite == null) {
                changePhase(Phase.LIGHT);
            } else if (++rebuilds >= 3) {
                stop(invalidSite);
            } else {
                rejectedSites.add(site);
                site = null;
                frameIndex = frameBlocks = 0;
                supplySince = tick;
                obsidianSearchSince = tick;
                siteSearchUntil = tick + 24;
                changePhase(Phase.SUPPLY);
            }
            return;
        }
        status = "dismantling the work pillar safely underfoot";
        if (tick - lowerSince > 220) {
            stop("could not descend the work pillar: " + (invalidSite == null ? "blocked scaffold" : invalidSite));
            return;
        }
        BlockPos top = site.stand.up(lift - 1);
        if (client.player.isOnGround() && (client.player.getBlockPos().getX() != top.getX()
                || client.player.getBlockPos().getZ() != top.getZ())) {
            invalidSite = "displaced from the work pillar before it could be dismantled";
            lift = 0;
            return;
        }
        if (client.player.getY() < top.getY() + 0.2 && client.player.isOnGround()) {
            lift = Math.max(0, client.player.getBlockY() - site.stand.getY());
            lowerSince = tick;
            return;
        }
        if (!client.player.isOnGround()) return;
        Vec3d point = new Vec3d(client.player.getX(), top.getY() + 0.86, client.player.getZ());
        body.aim(point);
        BlockHitResult hit = observed(point);
        if (hit != null && hit.getBlockPos().equals(top) && hit.getSide() == Direction.UP
                && state(hit).isOf(pillar[lift - 1]) && tools.readyFor(state(hit))
                && selected(top, Direction.UP)) {
            body.sneak();
            body.mine(top);
        }
    }

    private void light() {
        status = "igniting the built portal with flint and steel";
        if (tick - phaseSince > 165) {
            rejectSite("flint and steel did not produce a visible portal in the built frame");
            return;
        }
        BlockPos base = site.at(1, 0);
        Vec3d interior = Vec3d.ofCenter(base.up());
        if (ignitionUse != 0) {
            body.aim(interior);
            BlockHitResult observed = observed(interior);
            if (frameBlocks == OBSIDIAN_COUNT && observed != null && observed.getBlockPos().equals(base.up())
                    && state(observed).isOf(Blocks.NETHER_PORTAL)) {
                lit = true;
                changePhase(Phase.ENTER);
                return;
            }
            if (tick - ignitionUse < 14) return;
        }
        Vec3d point = facePoint(base, Direction.UP);
        body.aim(point);
        if (!body.aligned(point) || !hands.equip(STEEL) || !selected(base, Direction.UP)) return;
        BlockHitResult support = supportFace(base, Direction.UP, point);
        if (support != null && state(support).isOf(Blocks.OBSIDIAN)) {
            body.use(base, Direction.UP);
            ignitionUse = tick;
        }
    }

    private void enter(PilotProgress progress) {
        status = "entering the lit portal and waiting for the dimension change";
        if (tick - phaseSince > 330) {
            stop("attempted to enter the built portal but did not observe arrival in the Nether");
            return;
        }
        BlockPos inside = site.at(1, 1);
        Vec3d goal = Vec3d.ofBottomCenter(inside);
        Vec3d delta = goal.subtract(client.player.getPos());
        if (delta.horizontalLengthSquared() < 0.24 * 0.24 && delta.y < 0.35) {
            body.sneak();
            body.aim(goal.add(0, 1.4, 0));
            return;
        }
        Vec3d fromStand = client.player.getPos().subtract(Vec3d.ofBottomCenter(site.stand));
        Direction axis = site.axis();
        Direction facing = site.facing;
        double lateral = fromStand.x * axis.getOffsetX() + fromStand.z * axis.getOffsetZ();
        double forward = fromStand.x * facing.getOffsetX() + fromStand.z * facing.getOffsetZ();
        if (Math.abs(lateral) > 0.35 || forward < -0.35 || forward > 2.3) {
            progress.portalApproach(Vec3d.ofBottomCenter(site.stand));
            return;
        }
        if (delta.y < 0.35) body.sneak();
        moveKnown(delta, delta.y > 0.36 && delta.horizontalLengthSquared() < 1.4 * 1.4);
    }

    private boolean center(BlockPos stance) {
        Vec3d delta = Vec3d.ofBottomCenter(stance).subtract(client.player.getPos());
        if (Math.abs(delta.y) > 0.22 || !client.player.isOnGround()) return false;
        if (delta.horizontalLengthSquared() < 0.19 * 0.19) return true;
        if (delta.horizontalLengthSquared() < 0.62 * 0.62) {
            body.sneak();
            moveKnown(delta, false);
        }
        return false;
    }

    private void moveKnown(Vec3d delta, boolean jump) {
        float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
        body.turn(yaw, 30);
        if (Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - yaw)) > 14) return;
        body.walk(false);
        if (jump && client.player.isOnGround()) body.jump();
    }

    private BlockHitResult observed(Vec3d point) {
        return body.perceive(point, REACH).orElse(null);
    }

    private BlockHitResult supportFace(BlockPos pos, Direction face, Vec3d point) {
        BlockHitResult hit = observed(point);
        return hit != null && hit.getBlockPos().equals(pos) && hit.getSide() == face && usableSupport(state(hit))
            ? hit : null;
    }

    private boolean selected(BlockPos pos, Direction face) {
        BlockHitResult hit = body.selectedFace();
        return hit != null && hit.getBlockPos().equals(pos) && hit.getSide() == face;
    }

    private BlockState state(BlockHitResult hit) { return client.world.getBlockState(hit.getBlockPos()); }

    private static Vec3d facePoint(BlockPos pos, Direction face) {
        return Vec3d.ofCenter(pos).add(face.getOffsetX() * 0.49, face.getOffsetY() * 0.49, face.getOffsetZ() * 0.49);
    }

    private static boolean usableSupport(BlockState state) {
        return !state.isReplaceable() && state.getFluidState().isEmpty() && !state.isOf(Blocks.MAGMA_BLOCK)
            && !state.isOf(Blocks.CACTUS) && !state.isOf(Blocks.POWDER_SNOW) && !state.isOf(Blocks.CAMPFIRE)
            && !state.isOf(Blocks.SOUL_CAMPFIRE) && !state.isOf(Blocks.POINTED_DRIPSTONE)
            && !state.isOf(Blocks.SWEET_BERRY_BUSH);
    }

    private static boolean lavaSource(BlockState state) {
        var fluid = state.getFluidState();
        return fluid.isIn(FluidTags.LAVA) && fluid.isStill();
    }

    private static boolean waterSource(BlockState state) {
        var fluid = state.getFluidState();
        return state.isOf(Blocks.WATER) && fluid.isIn(FluidTags.WATER) && fluid.isStill();
    }

    private boolean ignored(BlockPos pos) {
        for (int i = 0; i < rejectedUntil.length; ++i) {
            if (tick < rejectedUntil[i] && pos.equals(rejectedMaterials[i])) return true;
        }
        return false;
    }

    private void ignore(BlockPos pos) {
        rejectedMaterials[ignoredIndex] = pos;
        rejectedUntil[ignoredIndex] = tick + 200;
        ignoredIndex = (ignoredIndex + 1) % rejectedMaterials.length;
    }

    private boolean has(Predicate<ItemStack> item, int quantity) { return hands.count(item) >= quantity; }

    private static Predicate<ItemStack> item(Item item) { return stack -> stack.isOf(item); }

    private void changePhase(Phase next) {
        phase = next;
        phaseSince = tick;
    }

    private void stop(String reason) {
        status = failure = "stopped: " + reason;
    }
}
