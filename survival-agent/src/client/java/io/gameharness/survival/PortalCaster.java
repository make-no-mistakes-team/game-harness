package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;

/**
 * Perception-honest single-bucket Nether portal shore-caster.
 *
 * Builds a complete 10-obsidian cornerless Nether portal directly on the shore of an
 * observed lava pool using at most 9 cobblestone support blocks (2 passive feet + 8 lava pours),
 * reclaims the water bucket, ignites the portal with flint & steel, and enters the Nether.
 */
final class PortalCaster {
    enum RunStatus { RUNNING, COMPLETED, FAILED }

    enum Stage {
        IDLE,
        SCAN_SITE,
        CLEAR_BANK,
        // Stage 1: zero-flood y=poolY shore pits to cast 2 passive feet (a0, a3) with ZERO pool flooding!
        MINE_FOOT0_PIT,
        WATER_FOOT0,
        WAIT_FOOT0,
        RECLAIM_FOOT0,
        MINE_FOOT1_PIT,
        WATER_FOOT1,
        WAIT_FOOT1,
        RECLAIM_FOOT1,
        // Stage 2: zero-flood y=poolY in-basin backstop casting -> mine bottom threshold DRY -> pour bottom threshold!
        PLACE_S1,
        PLACE_S2,
        MINE_S1,
        WATER_BACK1,
        WAIT_BACK1,
        RECLAIM_BACK1,
        MINE_S2,
        WATER_BACK2,
        WAIT_BACK2,
        RECLAIM_BACK2,
        MINE_TRENCH,
        WATER_TRENCH,
        POUR_BOTTOM1,
        POUR_BOTTOM2,
        RECLAIM_TRENCH,
        // Stage 3a: open shore drain gutter + cast left pillar layer-by-layer (y=64 then y=65) so ZERO water ever crosses a0!
        MINE_DRAIN1,
        MINE_DRAIN2,
        PLACE_S3,
        WATER_LEFT1,
        POUR_LEFT1,
        RECLAIM_LEFT1,
        PLACE_S4,
        WATER_LEFT2,
        POUR_LEFT2,
        RECLAIM_LEFT2,
        // Stage 3b: cast right pillar layer-by-layer (y=64 then y=65) so ZERO water ever crosses a3!
        PLACE_S5,
        WATER_RIGHT1,
        POUR_RIGHT1,
        RECLAIM_RIGHT1,
        PLACE_S6,
        WATER_RIGHT2,
        POUR_RIGHT2,
        RECLAIM_RIGHT2,
        // Stage 4: 1-high shore step (#7), back column top (#8), corner (#9) + lintel pours #1 & #2
        PLACE_S7,
        PLACE_S8,
        PLACE_S9,
        WATER_LINTEL1,
        POUR_LINTEL1,
        RECLAIM_LINTEL1,
        WATER_LINTEL2,
        POUR_LINTEL2,
        RECLAIM_LINTEL2,
        // Stage 5: wait for interior water to drain, ignite with flint & steel, step into Nether!
        DRAIN_INTERIOR,
        IGNITE,
        ENTER_PORTAL
    }

    /** Pure block probe used by unit-testable ShoreSite planning. */
    interface CellProbe {
        boolean isStillLava(BlockPos pos);
        boolean isSolid(BlockPos pos);
        boolean isPassableAir(BlockPos pos);
        default boolean isClearableDryBlock(BlockPos pos) { return false; }
    }

    /**
     * Exact cardinal geometry for a compact 9-support shore-cast Nether portal.
     * - foot0 = a0 at lava surface poolY
     * - along = horizontal direction of the 4-wide portal base (a0..a3)
     * - inward = horizontal direction into the lava pool (perpendicular to along)
     * - shore = inward.getOpposite() onto dry walkable bank at poolY + 1
     */
    record ShoreSite(BlockPos foot0, Direction along, Direction inward) {
        Direction shore() { return inward.getOpposite(); }
        Direction backAlong() { return along.getOpposite(); }

        BlockPos a0() { return foot0; }
        BlockPos a1() { return foot0.offset(along, 1); }
        BlockPos a2() { return foot0.offset(along, 2); }
        BlockPos a3() { return foot0.offset(along, 3); }

        List<BlockPos> passiveCells() {
            return List.of(a0(), a3());
        }

        List<BlockPos> pouredCells() {
            return List.of(
                a1().down(),
                a2().down(),
                a0().up(1),
                a0().up(2),
                a3().up(1),
                a3().up(2),
                a1().up(3),
                a2().up(3)
            );
        }

        List<BlockPos> allFrameCells() {
            List<BlockPos> all = new ArrayList<>(10);
            all.addAll(passiveCells());
            all.addAll(pouredCells());
            return all;
        }

        List<BlockPos> interiorCells() {
            return List.of(
                a1(), a2(),
                a1().up(1), a2().up(1),
                a1().up(2), a2().up(2)
            );
        }

        // Exact 9 cobblestone support positions (<= MAX_DIAGNOSTIC_SUPPORTS = 10)
        // Zero-flood interior waterfall geometry: all pillar & lintel #1 waterfalls drop strictly inside the enclosed a1/a2 basin!
        BlockPos s1() { return a1(); }
        BlockPos s2() { return a2(); }
        BlockPos s3() { return a1().offset(inward).up(1); }
        BlockPos s4() { return a1().offset(inward).up(2); }
        BlockPos s5() { return a2().offset(inward).up(1); }
        BlockPos s6() { return a2().offset(inward).up(2); }
        BlockPos s7() { return a1().offset(shore(), 2).up(1); }
        BlockPos s8() { return a2().offset(inward).up(3); }
        BlockPos s9() { return a0().up(3); }

        List<BlockPos> allSupportCells() {
            return List.of(s1(), s2(), s3(), s4(), s5(), s6(), s7(), s8(), s9());
        }

        // Water source cells per stage (ALL at y=poolY or enclosed interior so ZERO water ever floods the lava pool!)
        BlockPos waterFoot0() { return a0().offset(shore()); }
        BlockPos waterFoot1() { return a3().offset(shore()); }
        BlockPos waterBack1() { return a1(); }
        BlockPos waterBack2() { return a2(); }
        BlockPos waterTrench() { return a1(); }
        BlockPos waterLeft1() { return a1().up(1); }
        BlockPos waterLeft2() { return a1().up(2); }
        BlockPos waterRight1() { return a2().up(1); }
        BlockPos waterRight2() { return a2().up(2); }
        BlockPos waterLintel1() { return a2().up(3); }
        BlockPos waterLintel2() { return a3().up(3); }

        boolean isFrameOrInterior(BlockPos pos) {
            for (BlockPos p : allFrameCells()) if (p.equals(pos)) return true;
            for (BlockPos p : interiorCells()) if (p.equals(pos)) return true;
            return false;
        }

        /** Shore work-pad floor cells (bank1 + bank2 at y=poolY) that must be solid dry ground before casting. */
        List<BlockPos> bankFillCells() {
            List<BlockPos> out = new ArrayList<>(8);
            for (int i = 0; i < 4; i++) {
                out.add(foot0.offset(along, i).offset(shore(), 2));
            }
            for (int i = 0; i < 4; i++) {
                out.add(foot0.offset(along, i).offset(shore()));
            }
            return out;
        }

        /** Ordered top-down list of work-pad & overhead cells that must be clear air before casting. */
        List<BlockPos> bankClearCells() {
            List<BlockPos> out = new ArrayList<>(36);
            // Clear shore row 2 first (standing pad), then shore row 1, then overhead above lava base — top-down!
            for (int up = 2; up >= 1; up--) {
                for (int i = 0; i < 4; i++) {
                    out.add(foot0.offset(along, i).offset(shore(), 2).up(up));
                }
            }
            for (int up = 3; up >= 1; up--) {
                for (int i = 0; i < 4; i++) {
                    out.add(foot0.offset(along, i).offset(shore()).up(up));
                }
            }
            for (int up = 4; up >= 1; up--) {
                for (int i = 0; i < 4; i++) {
                    out.add(foot0.offset(along, i).up(up));
                }
            }
            return out;
        }
    }

    private record BucketPlaceAim(BlockPos support, Direction face, Vec3d point) {}

    private static final Direction[] HORIZONTALS = {
        Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST
    };

    private final MinecraftClient client;
    private final Motor motor;
    private final Perception perception;
    private final Pathfinder pathfinder;
    private final RouteExecutor route;
    private final GuiHands gui;

    private Stage stage = Stage.IDLE;
    private ShoreSite site;
    private int stageTicks;
    private int totalTicks;
    private int bucketCooldownTicks;
    private int aimStableTicks;
    private int pourConfirmTicks;
    private int scanTicks;
    private BlockPos activeWaterPos;
    private BlockPos activeLavaScoopTarget;
    private BlockPos activeRouteDest;
    private int lavaScoopStuckTicks;
    private final Set<BlockPos> skippedLavaCells = new HashSet<>();
    private String statusText = "";

    // Latched live telemetry (preserved cleanly across Overworld -> Nether dimension transition!)
    private final LinkedHashSet<BlockPos> observedPassiveCells = new LinkedHashSet<>();
    private final LinkedHashSet<BlockPos> observedPouredCells = new LinkedHashSet<>();
    private int latchedFrameBlocks;
    private boolean latchedIgnited;
    private boolean usedShoreCast;

    PortalCaster(MinecraftClient client, Motor motor, Perception perception,
                 Pathfinder pathfinder, RouteExecutor route, GuiHands gui) {
        this.client = client;
        this.motor = motor;
        this.perception = perception;
        this.pathfinder = pathfinder;
        this.route = route;
        this.gui = gui;
    }

    void resetForLife() {
        stage = Stage.IDLE;
        site = null;
        stageTicks = 0;
        totalTicks = 0;
        bucketCooldownTicks = 0;
        aimStableTicks = 0;
        pourConfirmTicks = 0;
        scanTicks = 0;
        activeWaterPos = null;
        activeLavaScoopTarget = null;
        activeRouteDest = null;
        lavaScoopStuckTicks = 0;
        skippedLavaCells.clear();
        statusText = "";
    }

    boolean isActive() { return stage != Stage.IDLE; }
    Stage stage() { return stage; }
    ShoreSite site() { return site; }
    String statusText() { return statusText; }
    boolean usedShoreCast() { return usedShoreCast; }
    int frameBlocks() { return latchedFrameBlocks; }
    boolean ignited() { return latchedIgnited; }
    int castPassiveBlocks() { return observedPassiveCells.size(); }
    int castLavaDeposits() { return observedPouredCells.size(); }
    int castFrameBlocks() { return Math.min(10, observedPassiveCells.size() + observedPouredCells.size()); }
    List<BlockPos> castPassiveCells() { return new ArrayList<>(observedPassiveCells); }
    List<BlockPos> castPouredCells() { return new ArrayList<>(observedPouredCells); }

    /** True if the player carries the core shore-casting kit (bucket w/ water, flint & steel, pickaxe, >= 9 cobble/blocks). */
    static boolean hasCastingKit(ClientPlayerEntity player) {
        if (player == null) return false;
        boolean hasBucket = GuiHands.countItem(player, Items.WATER_BUCKET) > 0
            || GuiHands.countItem(player, Items.BUCKET) > 0
            || GuiHands.countItem(player, Items.LAVA_BUCKET) > 0;
        boolean hasFlint = GuiHands.countItem(player, Items.FLINT_AND_STEEL) > 0;
        boolean hasPick = TaskRunner.bestPickaxeTier(player) >= 1;
        boolean hasBlocks = countSupportBlocks(player) >= 9;
        return hasBucket && hasFlint && hasPick && hasBlocks;
    }

    static int countSupportBlocks(ClientPlayerEntity player) {
        if (player == null) return 0;
        return GuiHands.countItem(player, Items.COBBLESTONE)
            + GuiHands.countItem(player, Items.COBBLED_DEEPSLATE)
            + GuiHands.countItem(player, Items.DIRT);
    }

    /** True if a valid lava-pool shore site is currently known from honest perception. */
    boolean hasObservedLavaPoolSite(ClientPlayerEntity player, ClientWorld world) {
        if (site != null) return true;
        if (player == null || world == null || perception.observedLava().size() < 10) return false;
        return findBestShoreSite(worldProbe(world), perception.observedLava(), player.getBlockPos()) != null;
    }

    void start(ClientPlayerEntity player, ClientWorld world) {
        if (stage != Stage.IDLE && site != null) return;
        stage = Stage.SCAN_SITE;
        stageTicks = 0;
        totalTicks = 0;
        scanTicks = 0;
        pourConfirmTicks = 0;
        activeLavaScoopTarget = null;
        lavaScoopStuckTicks = 0;
        skippedLavaCells.clear();
        statusText = "scanning lava pool shore";
    }

    void clearActive() {
        stage = Stage.IDLE;
        statusText = "";
        activeRouteDest = null;
        route.clear();
    }

    /** Pure, unit-testable shore-site planner over genuinely observed lava cells. */
    static ShoreSite findBestShoreSite(CellProbe probe, Collection<BlockPos> observedLava, BlockPos playerFeet) {
        if (probe == null || observedLava == null || observedLava.size() < 10 || playerFeet == null) return null;

        // Collect all still lava sources by Y level
        Set<BlockPos> stillLava = new HashSet<>();
        for (BlockPos p : observedLava) {
            if (probe.isStillLava(p)) stillLava.add(p.toImmutable());
        }
        if (stillLava.size() < 10) return null;

        ShoreSite best = null;
        double bestScore = Double.POSITIVE_INFINITY;

        for (BlockPos candidateA0 : stillLava) {
            int poolY = candidateA0.getY();
            for (Direction inward : HORIZONTALS) {
                Direction along = inward.rotateYCounterclockwise(); // right-handed: e.g. inward=SOUTH -> along=EAST!
                ShoreSite cand = new ShoreSite(candidateA0, along, inward);
                int prepCost = countRequiredBankPrep(probe, cand, stillLava, poolY);
                if (prepCost < 0) continue;

                // Score: prefer close to player, flat air banks (0 prep), centered along pool rim, and rich in nearby lava sources
                double dist = Math.sqrt(cand.a1().getSquaredDistance(playerFeet));
                int nearbyLava = 0;
                for (BlockPos lv : stillLava) {
                    if (lv.getY() == poolY && lv.getSquaredDistance(cand.a1()) <= 100.0) nearbyLava++;
                }
                if (nearbyLava < 10) continue;
                double centerBonus = probe.isStillLava(cand.a0().offset(cand.backAlong()))
                    && probe.isStillLava(cand.a3().offset(along)) ? -2.5 : 0.0;
                double score = dist + prepCost * 2.5 - Math.min(20, nearbyLava) * 0.15 + centerBonus;
                if (score < bestScore) {
                    bestScore = score;
                    best = cand;
                }
            }
        }
        return best;
    }

    /**
     * Returns weighted shore-preparation cost (cleared blocks + 2 * floor fills), or -1 if invalid.
     * Supports flat diagnostic pools (0 prep), natural raised-rim surface pools, and irregular underground y=-54 caves!
     */
    private static int countRequiredBankPrep(CellProbe probe, ShoreSite s, Set<BlockPos> stillLava, int poolY) {
        int clearBlocks = 0;
        int floorFills = 0;

        // 0. Passive water pockets (waterFoot0, waterFoot1) must have solid floors and must NOT leak sideways into lava!
        if (!probe.isSolid(s.waterFoot0().down()) || !probe.isSolid(s.waterFoot1().down())) return -1;
        if (stillLava.contains(s.waterFoot0().offset(s.backAlong()))
                || stillLava.contains(s.waterFoot1().offset(s.along()))) {
            return -1;
        }

        // 1. Passive feet a0 & a3 must be still lava (floor below a0/a3 can be solid OR deeper lava!).
        //    Interior base cells a1 & a2 may be still lava, passable air, OR clearable dry rock (always mined for trench!),
        //    with solid rock at poolY-1 and poolY-2 so bottom threshold pours #1 & #2 stay dry and never leak downward!
        for (int i = 0; i < 4; i++) {
            BlockPos base = s.foot0().offset(s.along(), i);
            if (i == 0 || i == 3) {
                if (!stillLava.contains(base)) return -1;
            } else {
                if (!stillLava.contains(base) && !probe.isPassableAir(base) && !probe.isClearableDryBlock(base)) {
                    return -1;
                }
                if (!probe.isSolid(base.down(1)) || !probe.isSolid(base.down(2))) return -1;
            }
            if (!probe.isPassableAir(base.up(1))) {
                if (probe.isClearableDryBlock(base.up(1))) clearBlocks++;
                else return -1;
            }
            for (int up = 2; up <= 4; up++) {
                BlockPos overhead = base.up(up);
                if (probe.isPassableAir(overhead)) continue;
                if (probe.isClearableDryBlock(overhead)) {
                    clearBlocks++;
                } else {
                    return -1;
                }
            }
            // Dry solid shore directly behind each base cell (2-deep apron; allow up to 4 floor fills on uneven rims
            // and stepped cave walls that CLEAR_BANK will level cleanly!)
            BlockPos bank1 = base.offset(s.shore());
            BlockPos bank2 = base.offset(s.shore(), 2);
            for (BlockPos b : new BlockPos[] { bank1, bank2 }) {
                if (!probe.isSolid(b)) {
                    if (probe.isPassableAir(b) && probe.isSolid(b.down())) {
                        floorFills++;
                    } else {
                        return -1;
                    }
                }
            }
            for (int up = 1; up <= 3; up++) {
                BlockPos b1 = bank1.up(up);
                if (!probe.isPassableAir(b1)) {
                    if (probe.isClearableDryBlock(b1)) clearBlocks++;
                    else return -1;
                }
                if (up <= 2) {
                    BlockPos b2 = bank2.up(up);
                    if (!probe.isPassableAir(b2)) {
                        if (probe.isClearableDryBlock(b2)) clearBlocks++;
                        else return -1;
                    }
                }
            }
            if (clearBlocks > 36 || floorFills > 4) return -1;
        }
        // 2. Solid stone/floor beneath the backstop cells (a1.offset(inward).down(), a2.offset(inward).down())
        //    so mining the bottom threshold trench cannot leak side lava from underneath!
        if (!probe.isSolid(s.a1().offset(s.inward()).down()) || !probe.isSolid(s.a2().offset(s.inward()).down())) {
            return -1;
        }
        return clearBlocks + floorFills * 2;
    }

    private CellProbe worldProbe(ClientWorld world) {
        return new CellProbe() {
            @Override
            public boolean isStillLava(BlockPos pos) {
                BlockState st = perception.getObserved(pos);
                if (st == null) return false;
                return st.getFluidState().isIn(FluidTags.LAVA) && st.getFluidState().isStill();
            }

            @Override
            public boolean isSolid(BlockPos pos) {
                BlockState st = perception.getObserved(pos);
                if (st == null) st = world.getBlockState(pos);
                return Perception.isSolidSupport(st);
            }

            @Override
            public boolean isPassableAir(BlockPos pos) {
                BlockState st = perception.getObserved(pos);
                if (st == null) st = world.getBlockState(pos);
                return st.isAir() || (st.isReplaceable() && st.getFluidState().isEmpty());
            }

            @Override
            public boolean isClearableDryBlock(BlockPos pos) {
                BlockState st = perception.getObserved(pos);
                if (st == null) st = world.getBlockState(pos);
                if (st.isAir() || !st.getFluidState().isEmpty()) return false;
                if (Perception.isUnbreakable(st) || Perception.isHazardBlock(st)) return false;
                if (st.isOf(Blocks.OBSIDIAN)) return false;
                // Never mine a block with fluid directly above or directly on its shore-facing sides!
                if (!world.getBlockState(pos.up()).getFluidState().isEmpty()) return false;
                return true;
            }
        };
    }

    /** Refresh latched Overworld portal telemetry every tick (never resets upon entering Nether!). */
    void tickTelemetry(ClientWorld world) {
        if (world == null || site == null) return;
        if (!"minecraft:overworld".equals(world.getRegistryKey().getValue().toString())) return;

        int obsCount = 0;
        for (BlockPos p : site.passiveCells()) {
            if (world.getBlockState(p).isOf(Blocks.OBSIDIAN)) {
                observedPassiveCells.add(p);
                obsCount++;
            }
        }
        for (BlockPos p : site.pouredCells()) {
            if (world.getBlockState(p).isOf(Blocks.OBSIDIAN)) {
                observedPouredCells.add(p);
                obsCount++;
            }
        }
        latchedFrameBlocks = Math.max(latchedFrameBlocks, obsCount);
        for (BlockPos inner : site.interiorCells()) {
            if (world.getBlockState(inner).isOf(Blocks.NETHER_PORTAL)) {
                latchedIgnited = true;
                break;
            }
        }
    }

    /** Advance portal shore-casting by one 20-TPS tick. */
    RunStatus tick(ClientPlayerEntity player, ClientWorld world, int currentTick) {
        if (player == null || world == null || !player.isAlive()) {
            return RunStatus.FAILED;
        }
        if ("minecraft:the_nether".equals(world.getRegistryKey().getValue().toString())) {
            statusText = "arrived in the nether";
            return RunStatus.COMPLETED;
        }
        if (bucketCooldownTicks > 0) bucketCooldownTicks--;
        totalTicks++;
        stageTicks++;

        if (totalTicks > 4200) {
            clearActive();
            return RunStatus.FAILED;
        }
        if (gui.isBusy()) {
            gui.tick();
            statusText = "equipping portal gear";
            return RunStatus.RUNNING;
        }

        tickTelemetry(world);

        RunStatus res = switch (stage) {
            case IDLE, SCAN_SITE -> tickScanSite(player, world);
            case CLEAR_BANK -> tickClearBank(player, world);

            // Stage 1: zero-flood y=poolY shore pits cast a0 & a3 passively without touching any other lava!
            case MINE_FOOT0_PIT -> tickMineSingleBlock(player, world, site.waterFoot0(), site.a0().offset(site.shore(), 2).up(), Stage.WATER_FOOT0, "digging left shore water pocket");
            case WATER_FOOT0 -> tickPlaceWater(player, world, site.waterFoot0(), site.waterFoot0().down(), Direction.UP,
                site.a0().offset(site.shore(), 2).up(), null, null, Stage.WAIT_FOOT0, "pouring water for left passive foot");
            case WAIT_FOOT0 -> tickWaitObsidian(player, world, site.a0(), true, Stage.RECLAIM_FOOT0, "forming left passive obsidian foot");
            case RECLAIM_FOOT0 -> tickReclaimWater(player, world, site.waterFoot0(), site.a0().offset(site.shore(), 2).up(), null, null, Stage.MINE_FOOT1_PIT, "reclaiming water after left foot");

            case MINE_FOOT1_PIT -> tickMineSingleBlock(player, world, site.waterFoot1(), site.a3().offset(site.shore(), 2).up(), Stage.WATER_FOOT1, "digging right shore water pocket");
            case WATER_FOOT1 -> tickPlaceWater(player, world, site.waterFoot1(), site.waterFoot1().down(), Direction.UP,
                site.a3().offset(site.shore(), 2).up(), null, null, Stage.WAIT_FOOT1, "pouring water for right passive foot");
            case WAIT_FOOT1 -> tickWaitObsidian(player, world, site.a3(), true, Stage.RECLAIM_FOOT1, "forming right passive obsidian foot");
            case RECLAIM_FOOT1 -> tickReclaimWater(player, world, site.waterFoot1(), site.a3().offset(site.shore(), 2).up(), null, null, Stage.PLACE_S1, "reclaiming water after right foot");

            // Stage 2: zero-flood in-basin backstop casting -> dry trench mining -> bottom threshold pours #1 & #2
            case PLACE_S1 -> tickPlaceCobble(player, world, site.s1(), site.a1().offset(site.shore()).up(), null, null, true, Stage.PLACE_S2, "clearing interior lava #1");
            case PLACE_S2 -> tickPlaceCobble(player, world, site.s2(), site.a2().offset(site.shore()).up(), null, null, true, Stage.MINE_S1, "clearing interior lava #2");
            case MINE_S1 -> tickMineSingleBlock(player, world, site.s1(), site.a1().offset(site.shore()).up(),
                isSolidBackstop(world, site.a1().offset(site.inward())) ? Stage.MINE_S2 : Stage.WATER_BACK1, "opening basin #1 for backstop");
            case WATER_BACK1 -> tickPlaceWater(player, world, site.waterBack1(), site.a1().down(), Direction.UP,
                site.a1().offset(site.shore()).up(), null, null, Stage.WAIT_BACK1, "casting obsidian backstop #1");
            case WAIT_BACK1 -> tickWaitObsidian(player, world, site.a1().offset(site.inward()), false, Stage.RECLAIM_BACK1, "solidifying obsidian backstop #1");
            case RECLAIM_BACK1 -> tickReclaimWater(player, world, site.waterBack1(), site.a1().offset(site.shore()).up(), null, null, Stage.MINE_S2, "reclaiming backstop #1 water");
            case MINE_S2 -> tickMineSingleBlock(player, world, site.s2(), site.a2().offset(site.shore()).up(),
                isSolidBackstop(world, site.a2().offset(site.inward())) ? Stage.MINE_TRENCH : Stage.WATER_BACK2, "opening basin #2 for backstop");
            case WATER_BACK2 -> tickPlaceWater(player, world, site.waterBack2(), site.a2().down(), Direction.UP,
                site.a2().offset(site.shore()).up(), null, null, Stage.WAIT_BACK2, "casting obsidian backstop #2");
            case WAIT_BACK2 -> tickWaitObsidian(player, world, site.a2().offset(site.inward()), false, Stage.RECLAIM_BACK2, "solidifying obsidian backstop #2");
            case RECLAIM_BACK2 -> tickReclaimWater(player, world, site.waterBack2(), site.a2().offset(site.shore()).up(), null, null, Stage.MINE_TRENCH, "reclaiming backstop #2 water");
            case MINE_TRENCH -> tickMineTrench(player, world);
            case WATER_TRENCH -> tickPlaceWater(player, world, site.waterTrench(), site.a1().offset(site.inward()), site.shore(),
                site.a1().offset(site.shore()).up(), null, null, Stage.POUR_BOTTOM1, "pouring enclosed trench water");
            case POUR_BOTTOM1 -> tickPourLavaCell(player, world, site.a1().down(), site.a1().down().offset(site.inward()), site.shore(),
                site.a2().offset(site.shore()).up(), null, null, true, Stage.POUR_BOTTOM2, "casting bottom threshold #1");
            case POUR_BOTTOM2 -> tickPourLavaCell(player, world, site.a2().down(), site.a2().down().offset(site.inward()), site.shore(),
                site.a2().offset(site.shore()).up(), null, null, true, Stage.RECLAIM_TRENCH, "casting bottom threshold #2");
            case RECLAIM_TRENCH -> tickReclaimWater(player, world, site.waterTrench(), site.a1().offset(site.shore()).up(), null, null, Stage.MINE_DRAIN1, "reclaiming trench water");

            // Stage 3a: open shore drain gutter + cast left pillar layer-by-layer (y=64 then y=65) so ZERO water crosses a0!
            case MINE_DRAIN1 -> tickMineSingleBlock(player, world, site.a1().offset(site.shore()), site.a1().offset(site.shore(), 2).up(), Stage.MINE_DRAIN2, "digging shore drain gutter #1");
            case MINE_DRAIN2 -> tickMineSingleBlock(player, world, site.a2().offset(site.shore()), site.a2().offset(site.shore(), 2).up(), Stage.PLACE_S3, "digging shore drain gutter #2");
            case PLACE_S3 -> tickPlaceCobble(player, world, site.s3(), site.a1().offset(site.shore(), 2).up(), null, null, false, Stage.WATER_LEFT1, "placing left waterfall backstop #1");
            case WATER_LEFT1 -> tickPlaceWater(player, world, site.waterLeft1(), site.s3(), site.shore(),
                site.a1().offset(site.shore(), 2).up(), null, null, Stage.POUR_LEFT1, "pouring left pillar water #1");
            case POUR_LEFT1 -> tickPourLavaCell(player, world, site.a0().up(1), site.a0(), Direction.UP,
                site.a0().offset(site.shore(), 2).up(), null, null, false, Stage.RECLAIM_LEFT1, "casting left pillar #1");
            case RECLAIM_LEFT1 -> tickReclaimWater(player, world, site.waterLeft1(), site.a1().offset(site.shore(), 2).up(), null, null, Stage.PLACE_S4, "reclaiming left pillar water #1");
            case PLACE_S4 -> tickPlaceCobble(player, world, site.s4(), site.a1().offset(site.shore(), 2).up(), null, null, false, Stage.WATER_LEFT2, "placing left waterfall backstop #2");
            case WATER_LEFT2 -> tickPlaceWater(player, world, site.waterLeft2(), site.s4(), site.shore(),
                site.a1().offset(site.shore(), 2).up(), null, null, Stage.POUR_LEFT2, "pouring left pillar water #2");
            case POUR_LEFT2 -> tickPourLavaCell(player, world, site.a0().up(2), site.a0().up(1), Direction.UP,
                site.a0().offset(site.shore(), 2).up(), null, null, false, Stage.RECLAIM_LEFT2, "casting left pillar #2");
            case RECLAIM_LEFT2 -> tickReclaimWater(player, world, site.waterLeft2(), site.a1().offset(site.shore(), 2).up(), null, null, Stage.PLACE_S5, "reclaiming left pillar water #2");

            // Stage 3b: cast right pillar layer-by-layer (y=64 then y=65) so ZERO water crosses a3!
            case PLACE_S5 -> tickPlaceCobble(player, world, site.s5(), site.a2().offset(site.shore(), 2).up(), null, null, false, Stage.WATER_RIGHT1, "placing right waterfall backstop #1");
            case WATER_RIGHT1 -> tickPlaceWater(player, world, site.waterRight1(), site.s5(), site.shore(),
                site.a2().offset(site.shore(), 2).up(), null, null, Stage.POUR_RIGHT1, "pouring right pillar water #1");
            case POUR_RIGHT1 -> tickPourLavaCell(player, world, site.a3().up(1), site.a3(), Direction.UP,
                site.a3().offset(site.shore(), 2).up(), null, null, false, Stage.RECLAIM_RIGHT1, "casting right pillar #1");
            case RECLAIM_RIGHT1 -> tickReclaimWater(player, world, site.waterRight1(), site.a2().offset(site.shore(), 2).up(), null, null, Stage.PLACE_S6, "reclaiming right pillar water #1");
            case PLACE_S6 -> tickPlaceCobble(player, world, site.s6(), site.a2().offset(site.shore(), 2).up(), null, null, false, Stage.WATER_RIGHT2, "placing right waterfall backstop #2");
            case WATER_RIGHT2 -> tickPlaceWater(player, world, site.waterRight2(), site.s6(), site.shore(),
                site.a2().offset(site.shore(), 2).up(), null, null, Stage.POUR_RIGHT2, "pouring right pillar water #2");
            case POUR_RIGHT2 -> tickPourLavaCell(player, world, site.a3().up(2), site.a3().up(1), Direction.UP,
                site.a3().offset(site.shore(), 2).up(), null, null, false, Stage.RECLAIM_RIGHT2, "casting right pillar #2");
            case RECLAIM_RIGHT2 -> tickReclaimWater(player, world, site.waterRight2(), site.a2().offset(site.shore(), 2).up(), null, null, Stage.PLACE_S7, "reclaiming right pillar water #2");

            // Stage 4: single 1-high shore step (#7 at z=0), back column top (#8), corner (#9) + lintel pours #1 & #2
            case PLACE_S7 -> tickPlaceCobble(player, world, site.s7(), site.a2().offset(site.shore(), 2).up(), null, null, false, Stage.PLACE_S8, "placing shore step-up block");
            case PLACE_S8 -> tickPlaceCobble(player, world, site.s8(), site.s7().up(), site.s7(), null, false, Stage.PLACE_S9, "placing lintel waterfall backstop");
            case PLACE_S9 -> tickPlaceCobble(player, world, site.s9(), site.s7().up(), site.s7(), null, false, Stage.WATER_LINTEL1, "placing upper corner support");
            case WATER_LINTEL1 -> tickPlaceWater(player, world, site.waterLintel1(), site.s8(), site.shore(),
                site.s7().up(), site.s7(), null, Stage.POUR_LINTEL1, "pouring drained lintel waterfall #1");
            case POUR_LINTEL1 -> tickPourLavaCell(player, world, site.a1().up(3), site.s9(), site.along(),
                site.a2().offset(site.shore(), 2).up(), null, null, false, Stage.RECLAIM_LINTEL1, "casting top lintel #1");
            case RECLAIM_LINTEL1 -> tickReclaimWater(player, world, site.waterLintel1(), site.a2().offset(site.shore(), 2).up(), site.s7(), null, Stage.WATER_LINTEL2, "reclaiming lintel water #1");
            case WATER_LINTEL2 -> tickPlaceWater(player, world, site.waterLintel2(), site.a3().up(2), Direction.UP,
                site.s7().up(), site.s7(), null, Stage.POUR_LINTEL2, "pouring final lintel water");
            case POUR_LINTEL2 -> tickPourLavaCell(player, world, site.a2().up(3), site.a1().up(3), site.along(),
                site.a3().offset(site.shore(), 2).up(), null, null, false, Stage.RECLAIM_LINTEL2, "casting top lintel #2");
            case RECLAIM_LINTEL2 -> tickReclaimWater(player, world, site.waterLintel2(), site.a3().offset(site.shore(), 2).up(), site.s7(), null, Stage.DRAIN_INTERIOR, "reclaiming final water");

            // Stage 5: drain, ignite, enter Nether!
            case DRAIN_INTERIOR -> tickDrainInterior(player, world);
            case IGNITE -> tickIgnite(player, world);
            case ENTER_PORTAL -> tickEnterPortal(player, world);
        };

        // Hard lava-edge safety clamp: whenever directly adjacent to LAVA (never harmless 1-deep dry stone pits!),
        // engage vanilla sneak so it is physically impossible to step off a rim into lava!
        if (stage != Stage.ENTER_PORTAL && stage != Stage.IDLE && stage != Stage.SCAN_SITE
                && isDirectlyAdjacentToLava(world, player.getBlockPos()) && !isJumpingOntoStep(player)) {
            motor.requestSneak();
        }
        return res;
    }

    private Stage determineResumeStage(ClientWorld world) {
        if (!world.getBlockState(site.a0()).isOf(Blocks.OBSIDIAN)) {
            if (findNextBankFillCell(world) != null || findNextBankClearBlock(world) != null) return Stage.CLEAR_BANK;
            return Stage.MINE_FOOT0_PIT;
        }
        if (!world.getBlockState(site.a3()).isOf(Blocks.OBSIDIAN)) return Stage.MINE_FOOT1_PIT;
        if (!world.getBlockState(site.a1().down()).isOf(Blocks.OBSIDIAN)
                || !world.getBlockState(site.a2().down()).isOf(Blocks.OBSIDIAN)) {
            return backstopResumeStage(
                isSolidBackstop(world, site.a1().offset(site.inward())),
                isSolidBackstop(world, site.a2().offset(site.inward())),
                world.getBlockState(site.a2()).getFluidState().isIn(FluidTags.LAVA));
        }
        if (!world.getBlockState(site.a0().up(1)).isOf(Blocks.OBSIDIAN)) return Stage.MINE_DRAIN1;
        if (!world.getBlockState(site.a0().up(2)).isOf(Blocks.OBSIDIAN)) return Stage.PLACE_S4;
        if (!world.getBlockState(site.a3().up(1)).isOf(Blocks.OBSIDIAN)) return Stage.PLACE_S5;
        if (!world.getBlockState(site.a3().up(2)).isOf(Blocks.OBSIDIAN)) return Stage.PLACE_S6;
        if (!world.getBlockState(site.a1().up(3)).isOf(Blocks.OBSIDIAN)) return Stage.PLACE_S7;
        if (!world.getBlockState(site.a2().up(3)).isOf(Blocks.OBSIDIAN)) return Stage.WATER_LINTEL2;
        return Stage.DRAIN_INTERIOR;
    }

    /**
     * Pure resume decision for the stage-2 backstop sequence. Interior cell a2 must be plugged with
     * cobble (PLACE_S2) before MINE_S2 whenever it still holds lava; otherwise WATER_BACK2 would pour
     * onto interior lava and turn a portal interior cell into obsidian.
     */
    static Stage backstopResumeStage(boolean a1BackstopSolid, boolean a2BackstopSolid, boolean a2StillLava) {
        if (!a1BackstopSolid) return Stage.PLACE_S1;
        if (!a2BackstopSolid) return a2StillLava ? Stage.PLACE_S2 : Stage.MINE_S2;
        return Stage.MINE_TRENCH;
    }

    private void setStage(Stage next) {
        stage = next;
        stageTicks = 0;
        aimStableTicks = 0;
        pourConfirmTicks = 0;
        activeLavaScoopTarget = null;
        activeRouteDest = null;
        lavaScoopStuckTicks = 0;
        route.clear();
    }

    // ===================== STAGE 0: SCAN OBSERVED LAVA POOL =====================

    private RunStatus tickScanSite(ClientPlayerEntity player, ClientWorld world) {
        scanTicks++;
        statusText = "surveying lava pool shoreline";

        if (site == null && scanTicks >= 6) {
            site = findBestShoreSite(worldProbe(world), perception.observedLava(), player.getBlockPos());
        }
        if (site != null) {
            usedShoreCast = true;
            setStage(determineResumeStage(world));
            return RunStatus.RUNNING;
        }

        // If we spotted a distant lava pool (> 6m away), walk safely up to its dry rim so Perception sees the full pool!
        BlockPos nearestLava = perception.nearestObserved(perception.observedLava(), player.getBlockPos(), 48.0, null);
        if (nearestLava != null && player.getBlockPos().getSquaredDistance(nearestLava) > 5.5 * 5.5) {
            statusText = "approaching observed lava pool";
            Pathfinder.Options opts = Pathfinder.Options.mining(TaskRunner.scaffoldCount(player), player.getHealth() > 10f, true);
            if (!route.hasPlan()) {
                Pathfinder.Plan plan = pathfinder.search(perception, player, player.getBlockPos(),
                    Pathfinder.Goal.near(nearestLava.up(), 4.2), opts);
                if (!plan.isEmpty()) {
                    route.setPlan(plan);
                } else {
                    motor.lookAtPoint(Vec3d.ofCenter(nearestLava), Motor.LookMode.SCAN);
                }
            } else {
                RouteExecutor.Status st = route.tick(totalTicks, true);
                if (st == RouteExecutor.Status.COMPLETE || st == RouteExecutor.Status.STUCK || st == RouteExecutor.Status.INVALIDATED) {
                    route.clear();
                }
            }
            if (scanTicks > 360) {
                clearActive();
                return RunStatus.FAILED;
            }
            return RunStatus.RUNNING;
        }

        // Close to the lava pool: smoothly sweep gaze across the pool & rim so Perception maps all lava sources!
        float sweepYaw = player.getYaw() + (scanTicks % 30 < 15 ? 16f : -16f);
        motor.lookAtAngles(sweepYaw, 28f, Motor.LookMode.SCAN);
        if (scanTicks > 180) {
            clearActive();
            return RunStatus.FAILED;
        }
        return RunStatus.RUNNING;
    }

    private static boolean isSolidBackstop(ClientWorld world, BlockPos pos) {
        BlockState st = world.getBlockState(pos);
        return Perception.isSolidSupport(st) && st.getFluidState().isEmpty();
    }

    private BlockPos findNextBankFillCell(ClientWorld world) {
        if (site == null) return null;
        for (BlockPos p : site.bankFillCells()) {
            BlockState st = world.getBlockState(p);
            if (!Perception.isSolidSupport(st) && Perception.isSolidSupport(world.getBlockState(p.down()))) {
                return p;
            }
        }
        return null;
    }

    private BlockPos findNextBankClearBlock(ClientWorld world) {
        if (site == null) return null;
        for (BlockPos p : site.bankClearCells()) {
            BlockState st = world.getBlockState(p);
            if (!st.isAir() && !(st.isReplaceable() && st.getFluidState().isEmpty())
                    && st.getFluidState().isEmpty() && !Perception.isUnbreakable(st) && !st.isOf(Blocks.OBSIDIAN)) {
                return p;
            }
        }
        return null;
    }

    private RunStatus tickClearBank(ClientPlayerEntity player, ClientWorld world) {
        statusText = "clearing lava shore work pad";
        if (stageTicks > 800) {
            // Proceed even if a stubborn overhead block remained
            setStage(Stage.MINE_FOOT0_PIT);
            return RunStatus.RUNNING;
        }
        // 1. Fill any 1-block notch/dip in bank1 or bank2 at y=poolY so the dry shore pad & water-pocket walls are solid!
        BlockPos fillTarget = findNextBankFillCell(world);
        if (fillTarget != null) {
            statusText = "leveling lava shore floor";
            int cobbleSlot = ensureCobbleHotbar(player);
            if (cobbleSlot >= 0) {
                if (motor.findPlacementHit(fillTarget) != null) {
                    motor.requestSneak();
                    if (bucketCooldownTicks <= 0 && motor.placeBlockAt(fillTarget, cobbleSlot)) {
                        bucketCooldownTicks = 5;
                    }
                    return RunStatus.RUNNING;
                }
                Pathfinder.Options opts = Pathfinder.Options.mining(TaskRunner.scaffoldCount(player), player.getHealth() > 10f, true);
                if (!route.hasPlan() || activeRouteDest == null || !activeRouteDest.equals(fillTarget)) {
                    Pathfinder.Plan plan = pathfinder.search(perception, player, player.getBlockPos(),
                        Pathfinder.Goal.interactReach(fillTarget, 3.2), opts);
                    if (!plan.isEmpty()) {
                        route.setPlan(plan);
                        activeRouteDest = fillTarget;
                    } else {
                        moveToDryGroundSpot(player, world, fillTarget.offset(site.shore()).up(), false, true);
                    }
                } else {
                    RouteExecutor.Status st = route.tick(totalTicks, true);
                    if (st == RouteExecutor.Status.COMPLETE || st == RouteExecutor.Status.STUCK || st == RouteExecutor.Status.INVALIDATED) {
                        route.clear();
                        activeRouteDest = null;
                    }
                }
                return RunStatus.RUNNING;
            }
        }
        // 2. Clear raised bank blocks & overhead cave rock top-down!
        BlockPos target = findNextBankClearBlock(world);
        if (target == null) {
            setStage(Stage.MINE_FOOT0_PIT);
            return RunStatus.RUNNING;
        }
        Vec3d aim = motor.findAimPoint(target);
        if (aim != null && player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(target)) <= Motor.REACH_SQ) {
            motor.mineBlock(target, true, false);
            return RunStatus.RUNNING;
        }
        // Approach safely along the dry shore side (offset toward shore from target)
        BlockPos stand = new BlockPos(target.getX(), site.foot0().getY() + 1, target.getZ()).offset(site.shore(), 1);
        Pathfinder.Options opts = Pathfinder.Options.mining(TaskRunner.scaffoldCount(player), player.getHealth() > 10f, true);
        if (!route.hasPlan() || activeRouteDest == null || !activeRouteDest.equals(target)) {
            Pathfinder.Plan plan = pathfinder.search(perception, player, player.getBlockPos(),
                Pathfinder.Goal.interactReach(target, 3.2), opts);
            if (!plan.isEmpty()) {
                route.setPlan(plan);
                activeRouteDest = target;
            } else {
                moveToDryGroundSpot(player, world, stand, false, true);
            }
        } else {
            RouteExecutor.Status st = route.tick(totalTicks, true);
            if (st == RouteExecutor.Status.COMPLETE || st == RouteExecutor.Status.STUCK || st == RouteExecutor.Status.INVALIDATED) {
                route.clear();
                activeRouteDest = null;
            }
        }
        return RunStatus.RUNNING;
    }

    // ===================== GENERIC PLACE / WATER / POUR / RECLAIM STEPS =====================

    private RunStatus tickPlaceCobble(ClientPlayerEntity player, ClientWorld world, BlockPos targetPos,
                                      BlockPos standPos, BlockPos climbStep, BlockPos climbTower,
                                      boolean rimPeek, Stage nextStage, String label) {
        statusText = label;
        BlockState existing = world.getBlockState(targetPos);
        if (!existing.isAir() && !existing.isReplaceable() && existing.getFluidState().isEmpty()) {
            setStage(nextStage);
            return RunStatus.RUNNING;
        }
        int cobbleSlot = ensureCobbleHotbar(player);
        if (cobbleSlot < 0) {
            if (gui.isBusy()) return RunStatus.RUNNING;
            clearActive();
            return RunStatus.FAILED;
        }

        // If we already have a clean unobstructed placement raycast right now, hold steady and place!
        if (motor.findPlacementHit(targetPos) != null) {
            if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
            if (bucketCooldownTicks <= 0 && motor.placeBlockAt(targetPos, cobbleSlot)) {
                bucketCooldownTicks = 5;
            }
            return RunStatus.RUNNING;
        }

        boolean positioned = positionForAction(player, world, standPos, climbStep, climbTower, rimPeek);
        if (positioned) {
            if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
            if (bucketCooldownTicks <= 0 && motor.placeBlockAt(targetPos, cobbleSlot)) {
                bucketCooldownTicks = 5;
            }
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickPlaceWater(ClientPlayerEntity player, ClientWorld world,
                                     BlockPos waterPos, BlockPos supportPos, Direction clickFace,
                                     BlockPos standPos, BlockPos climbStep, BlockPos climbTower,
                                     Stage nextStage, String label) {
        statusText = label;
        if (isStillWater(world, waterPos)) {
            activeWaterPos = waterPos;
            setStage(nextStage);
            return RunStatus.RUNNING;
        }
        // Wait cleanly for server block-update sync right after clicking the water bucket!
        if (bucketCooldownTicks > 0) {
            if (climbTower != null || climbStep != null) motor.requestSneak();
            return RunStatus.RUNNING;
        }
        // If we somehow have an empty bucket while water landed slightly off-target or another source is active, reclaim it!
        int waterSlot = ensureItemInHotbar(player, Items.WATER_BUCKET);
        if (waterSlot < 0) {
            if (gui.isBusy()) return RunStatus.RUNNING;
            BlockPos stray = findNearbyStillWater(world, waterPos, 2);
            if (stray == null && activeWaterPos != null && isStillWater(world, activeWaterPos)) {
                stray = activeWaterPos;
            }
            if (stray != null) {
                tryScoopLiquid(player, world, stray, true);
                statusText = "reclaiming stray water bucket";
                return RunStatus.RUNNING;
            }
            if (stageTicks < 25) return RunStatus.RUNNING;
            clearActive();
            return RunStatus.FAILED;
        }

        BucketPlaceAim aim = findExplicitFaceAim(player, world, supportPos, clickFace);
        if (aim == null) {
            aim = findAnyBucketPlaceAim(player, world, waterPos);
        }
        // If we already have a clean raycast to the exact support face (and don't need to climb a tower to avoid drowning), place immediately!
        if (aim != null && (climbTower == null && climbStep == null || player.getBlockY() >= standPos.getY())) {
            if (climbTower != null || climbStep != null) motor.requestSneak();
            player.getInventory().selectedSlot = waterSlot;
            motor.lookAtPoint(aim.point(), Motor.LookMode.FINE);
            if (bucketCooldownTicks <= 0 && verifySettledBucketPlace(player, world, aim.support(), aim.face())) {
                useHeldBucket(player);
                activeWaterPos = waterPos;
            }
            return RunStatus.RUNNING;
        }

        boolean rimPeek = climbTower == null && climbStep == null && waterPos.getY() <= site.foot0().getY();
        boolean positioned = positionForAction(player, world, standPos, climbStep, climbTower, rimPeek);
        if (positioned && aim != null) {
            if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
            player.getInventory().selectedSlot = waterSlot;
            motor.lookAtPoint(aim.point(), Motor.LookMode.FINE);
            if (bucketCooldownTicks <= 0 && verifySettledBucketPlace(player, world, aim.support(), aim.face())) {
                useHeldBucket(player);
                activeWaterPos = waterPos;
            }
        } else {
            aimStableTicks = 0;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickMineSingleBlock(ClientPlayerEntity player, ClientWorld world, BlockPos targetPos,
                                          BlockPos standPos, Stage nextStage, String label) {
        statusText = label;
        BlockState st = world.getBlockState(targetPos);
        if (st.isAir() || !st.getFluidState().isEmpty()) {
            setStage(nextStage);
            return RunStatus.RUNNING;
        }
        Vec3d aim = motor.findAimPoint(targetPos);
        if (aim == null || player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(targetPos)) > Motor.REACH_SQ) {
            moveToDryGroundSpot(player, world, standPos, false, true);
        } else {
            motor.requestSneak();
            motor.mineBlock(targetPos, true, false);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickWaitObsidian(ClientPlayerEntity player, ClientWorld world, BlockPos targetPos,
                                       boolean passiveFoot, Stage nextStage, String label) {
        statusText = label;
        motor.lookAtPoint(Vec3d.ofCenter(targetPos), Motor.LookMode.FINE);
        if (world.getBlockState(targetPos).isOf(Blocks.OBSIDIAN)) {
            if (passiveFoot) observedPassiveCells.add(targetPos);
            setStage(nextStage);
            return RunStatus.RUNNING;
        }
        if (stageTicks > 55) {
            setStage(nextStage);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickReclaimWater(ClientPlayerEntity player, ClientWorld world, BlockPos waterPos,
                                       BlockPos standPos, BlockPos climbStep, BlockPos climbTower,
                                       Stage nextStage, String label) {
        statusText = label;
        if (GuiHands.countItem(player, Items.WATER_BUCKET) > 0) {
            activeWaterPos = null;
            setStage(nextStage);
            return RunStatus.RUNNING;
        }
        if (bucketCooldownTicks > 0) {
            if (climbTower != null || climbStep != null) motor.requestSneak();
            return RunStatus.RUNNING;
        }
        BlockPos actualWater = isStillWater(world, waterPos) ? waterPos : findNearbyStillWater(world, waterPos, 3);
        if (actualWater == null) {
            if (stageTicks > 25) {
                activeWaterPos = null;
                setStage(nextStage);
            }
            return RunStatus.RUNNING;
        }
        int emptySlot = ensureItemInHotbar(player, Items.BUCKET);
        if (emptySlot < 0) {
            if (gui.isBusy() || stageTicks < 20) return RunStatus.RUNNING;
            clearActive();
            return RunStatus.FAILED;
        }

        // First try scooping directly from current position if water source is in clean unobstructed reach!
        if (canSeeLiquidSource(player, world, actualWater, true)) {
            if (climbTower != null || climbStep != null) motor.requestSneak();
            tryScoopLiquid(player, world, actualWater, true);
            return RunStatus.RUNNING;
        }

        // Otherwise move/climb to the designated vantage point and scoop!
        boolean rimPeek = climbTower == null && climbStep == null && actualWater.getY() <= site.foot0().getY();
        positionForAction(player, world, standPos, climbStep, climbTower, rimPeek);
        if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
        tryScoopLiquid(player, world, actualWater, true);
        return RunStatus.RUNNING;
    }

    // ===================== STAGE 2: TRENCH MINING =====================

    private RunStatus tickMineTrench(ClientPlayerEntity player, ClientWorld world) {
        statusText = "mining 2-deep threshold trench";
        BlockPos[] order = { site.a1(), site.a2(), site.a1().down(), site.a2().down() };
        BlockPos nextMine = null;
        for (BlockPos p : order) {
            BlockState st = world.getBlockState(p);
            if (!st.isAir() && st.getFluidState().isEmpty() && !st.isOf(Blocks.OBSIDIAN)) {
                nextMine = p;
                break;
            }
        }
        if (nextMine == null) {
            setStage(Stage.WATER_TRENCH);
            return RunStatus.RUNNING;
        }

        // Stand safely sneaking at the dry stone lip directly opposite nextMine so we look cleanly down into the trench!
        BlockPos dryStand = (nextMine.equals(site.a1()) || nextMine.equals(site.a1().down()))
            ? site.a1().offset(site.shore()).up()
            : site.a2().offset(site.shore()).up();
        Vec3d aim = motor.findAimPoint(nextMine);
        if (aim == null || player.getEyePos().squaredDistanceTo(Vec3d.ofCenter(nextMine)) > Motor.REACH_SQ) {
            moveToDryGroundSpot(player, world, dryStand, false, true);
            motor.requestSneak();
        } else {
            motor.requestSneak();
            motor.mineBlock(nextMine, true, false);
        }
        return RunStatus.RUNNING;
    }

    // ===================== LAVA SCOOP & POUR =====================

    private RunStatus tickPourLavaCell(ClientPlayerEntity player, ClientWorld world,
                                       BlockPos targetCell, BlockPos preferredSupport, Direction preferredFace,
                                       BlockPos standPos, BlockPos climbStep, BlockPos climbTower,
                                       boolean rimPeek, Stage nextStage, String label) {
        if (world.getBlockState(targetCell).isOf(Blocks.OBSIDIAN)) {
            observedPouredCells.add(targetCell);
            setStage(nextStage);
            return RunStatus.RUNNING;
        }

        // If we just poured lava and it's converting to obsidian, wait briefly before assuming we need another scoop!
        if (pourConfirmTicks > 0) {
            pourConfirmTicks--;
            statusText = label + " (solidifying)";
            motor.lookAtPoint(Vec3d.ofCenter(targetCell), Motor.LookMode.FINE);
            return RunStatus.RUNNING;
        }

        // Step A: Need a lava bucket? Go scoop one safely from an untouched pool source!
        int lavaSlot = ensureItemInHotbar(player, Items.LAVA_BUCKET);
        if (lavaSlot < 0) {
            if (gui.isBusy()) return RunStatus.RUNNING;
            return tickScoopLava(player, world, label);
        }

        // Step B: Check if water is ready & we already have a clean pouring raycast!
        statusText = label;
        BucketPlaceAim aim = findExplicitFaceAim(player, world, preferredSupport, preferredFace);
        if (aim == null) {
            aim = findAnyBucketPlaceAim(player, world, targetCell);
        }

        boolean waterReady = hasWaterForObsidian(world, targetCell);
        if (aim != null && waterReady && (climbTower == null && climbStep == null || player.getBlockY() >= standPos.getY())) {
            if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
            player.getInventory().selectedSlot = lavaSlot;
            motor.lookAtPoint(aim.point(), Motor.LookMode.FINE);
            if (bucketCooldownTicks <= 0 && verifySettledBucketPlace(player, world, aim.support(), aim.face())) {
                useHeldBucket(player);
                pourConfirmTicks = 12;
            }
            return RunStatus.RUNNING;
        }

        // Move/climb into pouring vantage point
        boolean positioned = positionForAction(player, world, standPos, climbStep, climbTower, rimPeek);
        if (!waterReady) {
            aimStableTicks = 0;
            if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
            motor.lookAtPoint(Vec3d.ofCenter(targetCell), Motor.LookMode.FINE);
            return RunStatus.RUNNING;
        }
        if (aim != null && positioned) {
            if (climbTower != null || climbStep != null || rimPeek) motor.requestSneak();
            player.getInventory().selectedSlot = lavaSlot;
            motor.lookAtPoint(aim.point(), Motor.LookMode.FINE);
            if (bucketCooldownTicks <= 0 && verifySettledBucketPlace(player, world, aim.support(), aim.face())) {
                useHeldBucket(player);
                pourConfirmTicks = 12;
            }
        } else {
            aimStableTicks = 0;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickScoopLava(ClientPlayerEntity player, ClientWorld world, String parentLabel) {
        statusText = "scooping lava for " + parentLabel;
        if (bucketCooldownTicks > 0) return RunStatus.RUNNING;
        int emptySlot = ensureItemInHotbar(player, Items.BUCKET);
        if (emptySlot < 0) {
            if (gui.isBusy() || stageTicks < 20) return RunStatus.RUNNING;
            clearActive();
            return RunStatus.FAILED;
        }

        // Validate current lava target
        if (activeLavaScoopTarget != null) {
            if (!isStillLava(world, activeLavaScoopTarget) || skippedLavaCells.contains(activeLavaScoopTarget)
                    || site.isFrameOrInterior(activeLavaScoopTarget)) {
                activeLavaScoopTarget = null;
                lavaScoopStuckTicks = 0;
            }
        }
        if (activeLavaScoopTarget == null) {
            activeLavaScoopTarget = findBestLavaScoopSource(player, world);
            lavaScoopStuckTicks = 0;
        }
        if (activeLavaScoopTarget == null) {
            // Clear skipped set once and retry if pool still has lava
            if (!skippedLavaCells.isEmpty()) {
                skippedLavaCells.clear();
                activeLavaScoopTarget = findBestLavaScoopSource(player, world);
            }
            if (activeLavaScoopTarget == null) {
                // Sweep gaze across the lava pool to refresh observed lava sources before giving up!
                if (stageTicks < 60) {
                    motor.lookAtPoint(Vec3d.ofCenter(site.a1().offset(site.inward(), 3)), Motor.LookMode.SCAN);
                    return RunStatus.RUNNING;
                }
                clearActive();
                return RunStatus.FAILED;
            }
        }

        lavaScoopStuckTicks++;
        if (lavaScoopStuckTicks > 90) {
            skippedLavaCells.add(activeLavaScoopTarget);
            activeLavaScoopTarget = null;
            lavaScoopStuckTicks = 0;
            route.clear();
            return RunStatus.RUNNING;
        }

        // Can we already scoop this lava source cleanly from our safe dry position?
        if (canSeeLiquidSource(player, world, activeLavaScoopTarget, false)) {
            motor.requestSneak();
            if (tryScoopLiquid(player, world, activeLavaScoopTarget, false)) {
                activeLavaScoopTarget = null;
                activeRouteDest = null;
                lavaScoopStuckTicks = 0;
                route.clear();
            }
            return RunStatus.RUNNING;
        }

        // Walk safely along dry stone bank to a dry standing spot within 3.2m of the lava source!
        BlockPos stand = findDryStandingSpotForLava(player, world, activeLavaScoopTarget);
        if (stand == null) {
            skippedLavaCells.add(activeLavaScoopTarget);
            activeLavaScoopTarget = null;
            return RunStatus.RUNNING;
        }

        // Use safe surface A* (avoids lava automatically!) or direct dry walk when clear
        if (player.getBlockPos().getSquaredDistance(stand) <= 1.2 * 1.2) {
            motor.requestSneak();
            if (tryScoopLiquid(player, world, activeLavaScoopTarget, false)) {
                activeLavaScoopTarget = null;
                activeRouteDest = null;
                lavaScoopStuckTicks = 0;
                route.clear();
            }
        } else {
            navigateDryAroundPool(player, world, stand);
        }
        return RunStatus.RUNNING;
    }

    // ===================== STAGE 5: DRAIN, IGNITE, ENTER NETHER =====================

    private RunStatus tickDrainInterior(ClientPlayerEntity player, ClientWorld world) {
        statusText = "waiting for portal interior to drain";
        // Walk calmly to dry shore in front of the open a2 portal lane while water finishes draining
        BlockPos stand = site.a2().offset(site.shore(), 2).up();
        if (player.getBlockPos().getSquaredDistance(stand) > 1.8 * 1.8) {
            navigateDryAroundPool(player, world, stand);
        } else {
            motor.lookAtPoint(Vec3d.ofCenter(site.a2()), Motor.LookMode.FINE);
        }

        boolean allClear = true;
        for (BlockPos inner : site.interiorCells()) {
            BlockState st = world.getBlockState(inner);
            if (!st.isAir() || !st.getFluidState().isEmpty()) {
                allClear = false;
                break;
            }
        }
        if (allClear || stageTicks > 110) {
            setStage(Stage.IGNITE);
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickIgnite(ClientPlayerEntity player, ClientWorld world) {
        statusText = "igniting nether portal";
        for (BlockPos inner : site.interiorCells()) {
            if (world.getBlockState(inner).isOf(Blocks.NETHER_PORTAL)) {
                latchedIgnited = true;
                setStage(Stage.ENTER_PORTAL);
                return RunStatus.RUNNING;
            }
        }
        int flintSlot = ensureItemInHotbar(player, Items.FLINT_AND_STEEL);
        if (flintSlot < 0) {
            if (gui.isBusy()) return RunStatus.RUNNING;
            clearActive();
            return RunStatus.FAILED;
        }

        // Stand directly on open dry shore in front of the drain gutter a2.offset(shore, 2).up() (or inside dry gutter a2.offset(shore))
        BlockPos stand = site.a2().offset(site.shore(), 2).up();
        BucketPlaceAim aim = findExplicitFaceAim(player, world, site.a2().down(), Direction.UP);
        if (aim == null) aim = findExplicitFaceAim(player, world, site.a1().down(), Direction.UP);
        if (aim == null) aim = findExplicitFaceAim(player, world, site.a3(), site.backAlong());
        if (aim == null) {
            navigateDryAroundPool(player, world, stand);
            return RunStatus.RUNNING;
        }
        motor.requestSneak();
        if (motor.placeBlockAgainst(aim.support(), aim.face(), aim.point(), flintSlot)) {
            bucketCooldownTicks = 5;
        }
        return RunStatus.RUNNING;
    }

    private RunStatus tickEnterPortal(ClientPlayerEntity player, ClientWorld world) {
        statusText = "entering nether portal";
        // Walk through the open a2 lane straight into a2 and hold still until teleported!
        Vec3d portalTarget = new Vec3d(site.a2().getX() + 0.5, site.a2().getY(), site.a2().getZ() + 0.5);
        double horiz = Math.hypot(player.getX() - portalTarget.x, player.getZ() - portalTarget.z);
        if (horiz > 0.25) {
            motor.moveToward(portalTarget, false, false, false, true);
        } else {
            // Stand still inside the swirling purple portal while vanilla charges teleport (~80 ticks)
            motor.lookAtPoint(portalTarget.add(site.inward().getOffsetX() * 2.0, 1.5, site.inward().getOffsetZ() * 2.0), Motor.LookMode.FINE);
        }
        return RunStatus.RUNNING;
    }

    // ===================== POSITIONING & STAIR CLIMBING =====================

    /**
     * Positions the player cleanly at either a ground spot (`climbStep == null`),
     * a 1-high step-up block (`climbStep != null, climbTower == null`),
     * or a 2-high shore tower (`climbStep != null, climbTower != null`).
     * Returns true when safely arrived and centered.
     */
    private boolean positionForAction(ClientPlayerEntity player, ClientWorld world,
                                      BlockPos standPos, BlockPos climbStep, BlockPos climbTower, boolean rimPeek) {
        if (climbTower != null && climbStep != null) {
            return climbTwoStepTower(player, world, climbStep, climbTower);
        }
        if (climbStep != null) {
            return climbOneStepBlock(player, world, climbStep);
        }
        return moveToDryGroundSpot(player, world, standPos, !rimPeek, rimPeek);
    }

    private boolean climbOneStepBlock(ClientPlayerEntity player, ClientWorld world, BlockPos stepBlock) {
        BlockPos topFeet = stepBlock.up();
        Vec3d safeTop = shoreBiasedPoint(topFeet);
        double horiz = Math.hypot(player.getX() - safeTop.x, player.getZ() - safeTop.z);
        if (player.getBlockY() == topFeet.getY() && horiz < 0.38 && player.isOnGround()) {
            motor.requestSneak();
            return true;
        }
        if (player.getBlockY() == topFeet.getY()) {
            motor.moveToward(safeTop, false, false, true, false);
            return horiz < 0.45;
        }
        // Approach from the safe shore side directly behind stepBlock so jumping pushes us onto stepBlock, never into lava!
        BlockPos launch = stepBlock.offset(site.shore());
        Vec3d launchPt = Vec3d.ofBottomCenter(launch);
        double launchDist = Math.hypot(player.getX() - launchPt.x, player.getZ() - launchPt.z);
        if (player.getBlockY() > topFeet.getY()) {
            // Standing higher (e.g. on tower) — step cleanly onto stepBlock
            motor.moveToward(safeTop, false, false, true, false);
            return false;
        }
        if (launchDist > 0.72 && Math.hypot(player.getX() - safeTop.x, player.getZ() - safeTop.z) > 1.25) {
            navigateDryAroundPool(player, world, launch);
            return false;
        }
        // Jump crisply onto stepBlock!
        boolean closeForJump = horiz < 1.35;
        motor.moveToward(safeTop, false, closeForJump && player.isOnGround(), false, false);
        return false;
    }

    private boolean climbTwoStepTower(ClientPlayerEntity player, ClientWorld world, BlockPos stepBlock, BlockPos towerTop) {
        BlockPos finalFeet = towerTop.up();
        Vec3d safeFinal = shoreBiasedPoint(finalFeet);
        double finalHoriz = Math.hypot(player.getX() - safeFinal.x, player.getZ() - safeFinal.z);
        if (player.getBlockY() == finalFeet.getY() && finalHoriz < 0.38 && player.isOnGround()) {
            motor.requestSneak();
            return true;
        }
        if (player.getBlockY() == finalFeet.getY()) {
            motor.moveToward(safeFinal, false, false, true, false);
            return finalHoriz < 0.45;
        }
        // If already standing on stepBlock.up(), jump laterally along the shore onto towerTop.up()!
        BlockPos midFeet = stepBlock.up();
        if (player.getBlockY() == midFeet.getY()) {
            Vec3d midCenter = shoreBiasedPoint(midFeet);
            if (Math.hypot(player.getX() - midCenter.x, player.getZ() - midCenter.z) < 0.85 || finalHoriz < 1.35) {
                motor.moveToward(safeFinal, false, player.isOnGround(), false, false);
                return false;
            }
        }
        // Otherwise climb onto stepBlock first!
        climbOneStepBlock(player, world, stepBlock);
        return false;
    }

    private boolean moveToDryGroundSpot(ClientPlayerEntity player, ClientWorld world, BlockPos standFeet,
                                        boolean shoreBias, boolean rimPeek) {
        Vec3d target = rimPeek
            ? new Vec3d(
                standFeet.getX() + 0.5 + site.inward().getOffsetX() * 0.24,
                standFeet.getY(),
                standFeet.getZ() + 0.5 + site.inward().getOffsetZ() * 0.24)
            : (shoreBias ? shoreBiasedPoint(standFeet) : Vec3d.ofBottomCenter(standFeet));
        double horiz = Math.hypot(player.getX() - target.x, player.getZ() - target.z);
        if (player.getBlockY() == standFeet.getY() && horiz < 0.32) {
            if (rimPeek) motor.requestSneak();
            return true;
        }
        if (player.getBlockY() > standFeet.getY()) {
            // Step carefully off tower back toward dry shore (never toward lava!)
            motor.moveToward(target, false, false, false, true);
            return false;
        }
        if (rimPeek && player.getBlockPos().getSquaredDistance(standFeet) <= 2.2 * 2.2) {
            // Sneak smoothly right up to the stone lip so feet never slip off into lava!
            motor.moveToward(target, false, false, true, false);
            return false;
        }
        navigateDryAroundPool(player, world, standFeet);
        return false;
    }

    private void navigateDryAroundPool(ClientPlayerEntity player, ClientWorld world, BlockPos dest) {
        if (dest != null && !dest.equals(activeRouteDest)) {
            route.clear();
            activeRouteDest = dest.toImmutable();
        }
        // Use Pathfinder.Options.surface (respects observed lava as HAZARD and stays on solid dry stone!)
        if (!route.hasPlan()) {
            Pathfinder.Options opts = Pathfinder.Options.surface(0, true);
            Pathfinder.Plan plan = pathfinder.search(perception, player, player.getBlockPos(), Pathfinder.Goal.near(dest, 0.75), opts);
            if (!plan.isEmpty()) {
                route.setPlan(plan);
            } else {
                // Direct careful walk if already unobstructed and very close
                Vec3d target = shoreBiasedPoint(dest);
                boolean nearLava = isNearLavaPos(world, player.getBlockPos());
                motor.moveToward(target, false, player.horizontalCollision, nearLava, true);
                return;
            }
        }
        RouteExecutor.Status st = route.tick(totalTicks, true);
        if (st == RouteExecutor.Status.COMPLETE || st == RouteExecutor.Status.STUCK || st == RouteExecutor.Status.INVALIDATED) {
            route.clear();
            activeRouteDest = null;
        }
    }

    private Vec3d shoreBiasedPoint(BlockPos feetPos) {
        return new Vec3d(
            feetPos.getX() + 0.5 + site.shore().getOffsetX() * 0.14,
            feetPos.getY(),
            feetPos.getZ() + 0.5 + site.shore().getOffsetZ() * 0.14
        );
    }

    // ===================== BUCKET & RAYCAST PRIMITIVES =====================

    private void useHeldBucket(ClientPlayerEntity player) {
        if (client.interactionManager == null) return;
        var res = client.interactionManager.interactItem(player, Hand.MAIN_HAND);
        if (res.isAccepted()) {
            player.swingHand(Hand.MAIN_HAND);
            bucketCooldownTicks = 5;
            aimStableTicks = 0;
        }
    }

    private boolean tryScoopLiquid(ClientPlayerEntity player, ClientWorld world, BlockPos sourcePos, boolean water) {
        int emptySlot = motor.findHotbarItem(Items.BUCKET);
        if (emptySlot < 0) return false;
        player.getInventory().selectedSlot = emptySlot;
        Vec3d aim = new Vec3d(sourcePos.getX() + 0.5, sourcePos.getY() + (water ? 0.55 : 0.82), sourcePos.getZ() + 0.5);
        motor.lookAtPoint(aim, Motor.LookMode.FINE);
        if (bucketCooldownTicks > 0) return false;
        BlockHitResult hit = raycastPlayerLook(player, world, 4.4, RaycastContext.FluidHandling.SOURCE_ONLY);
        boolean onTarget = hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(sourcePos)
            && (water ? isStillWater(world, sourcePos) : isStillLava(world, sourcePos))
            && motor.currentAimErrorDeg() < 2.0;
        if (onTarget) {
            aimStableTicks++;
            if (aimStableTicks >= 2) {
                useHeldBucket(player);
                return true;
            }
        } else {
            aimStableTicks = 0;
        }
        return false;
    }

    private boolean canSeeLiquidSource(ClientPlayerEntity player, ClientWorld world, BlockPos sourcePos, boolean water) {
        Vec3d eye = player.getEyePos();
        Vec3d target = new Vec3d(sourcePos.getX() + 0.5, sourcePos.getY() + (water ? 0.55 : 0.82), sourcePos.getZ() + 0.5);
        if (eye.squaredDistanceTo(target) > 4.25 * 4.25) return false;
        BlockHitResult hit = world.raycast(new RaycastContext(
            eye, target, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.SOURCE_ONLY, player));
        if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(sourcePos)) return false;
        return water ? isStillWater(world, sourcePos) : isStillLava(world, sourcePos);
    }

    /**
     * BucketItem.use() re-raycasts on the server using the previous tick's synced yaw/pitch!
     * Requiring 2 consecutive settled ticks on the exact face ensures server & client raycasts match 100%!
     */
    private boolean verifySettledBucketPlace(ClientPlayerEntity player, ClientWorld world, BlockPos support, Direction face) {
        BlockHitResult hit = raycastPlayerLook(player, world, 4.45, RaycastContext.FluidHandling.NONE);
        boolean ok = hit.getType() == HitResult.Type.BLOCK
            && hit.getBlockPos().equals(support)
            && hit.getSide() == face
            && motor.currentAimErrorDeg() < 1.8;
        if (ok) {
            aimStableTicks++;
            return aimStableTicks >= 2;
        }
        aimStableTicks = 0;
        return false;
    }

    private static BlockHitResult raycastPlayerLook(ClientPlayerEntity player, ClientWorld world,
                                                    double range, RaycastContext.FluidHandling fluidMode) {
        Vec3d eye = player.getEyePos();
        Vec3d look = player.getRotationVec(1.0f);
        Vec3d end = eye.add(look.multiply(range));
        return world.raycast(new RaycastContext(eye, end, RaycastContext.ShapeType.OUTLINE, fluidMode, player));
    }

    private BucketPlaceAim findExplicitFaceAim(ClientPlayerEntity player, ClientWorld world, BlockPos support, Direction face) {
        if (support == null || face == null) return null;
        BlockState st = world.getBlockState(support);
        if (st.isAir() || !st.getFluidState().isEmpty() || st.isReplaceable()) return null;
        Vec3d eye = player.getEyePos();
        double[][] uvs = { {0.5, 0.5}, {0.5, 0.65}, {0.35, 0.5}, {0.65, 0.5}, {0.5, 0.30}, {0.5, 0.78}, {0.25, 0.25}, {0.75, 0.75} };
        for (double[] uv : uvs) {
            Vec3d pt = pointOnFace(support, face, uv[0], uv[1]);
            if (eye.squaredDistanceTo(pt) > Motor.REACH_SQ) continue;
            Vec3d end = eye.add(pt.subtract(eye).multiply(1.03));
            BlockHitResult hit = world.raycast(new RaycastContext(
                eye, end, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.NONE, player));
            if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(support) && hit.getSide() == face) {
                return new BucketPlaceAim(support, face, pt);
            }
        }
        return null;
    }

    private BucketPlaceAim findAnyBucketPlaceAim(ClientPlayerEntity player, ClientWorld world, BlockPos targetCell) {
        Direction[] order = { Direction.DOWN, site.inward(), site.along(), site.backAlong(), site.shore(), Direction.UP };
        for (Direction offsetDir : order) {
            BlockPos support = targetCell.offset(offsetDir);
            Direction clickFace = offsetDir.getOpposite();
            BucketPlaceAim aim = findExplicitFaceAim(player, world, support, clickFace);
            if (aim != null) return aim;
        }
        return null;
    }

    private static Vec3d pointOnFace(BlockPos pos, Direction face, double u, double v) {
        double x = pos.getX(), y = pos.getY(), z = pos.getZ(), eps = 0.01;
        return switch (face) {
            case DOWN -> new Vec3d(x + u, y + eps, z + v);
            case UP -> new Vec3d(x + u, y + 1.0 - eps, z + v);
            case NORTH -> new Vec3d(x + u, y + v, z + eps);
            case SOUTH -> new Vec3d(x + u, y + v, z + 1.0 - eps);
            case WEST -> new Vec3d(x + eps, y + v, z + u);
            case EAST -> new Vec3d(x + 1.0 - eps, y + v, z + u);
        };
    }

    // ===================== LAVA SOURCE & DRY STANDING SEARCH =====================

    private BlockPos findBestLavaScoopSource(ClientPlayerEntity player, ClientWorld world) {
        BlockPos feet = player.getBlockPos();
        BlockPos best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        for (BlockPos lv : perception.observedLava()) {
            if (skippedLavaCells.contains(lv)) continue;
            if (site.isFrameOrInterior(lv)) continue;
            if (lv.getY() != site.foot0().getY()) continue;
            if (!isStillLava(world, lv)) continue;
            BlockPos drySpot = findDryStandingSpotForLava(player, world, lv);
            if (drySpot == null) continue;
            double score = Math.sqrt(drySpot.getSquaredDistance(feet)) + Math.sqrt(lv.getSquaredDistance(drySpot)) * 0.4;
            if (score < bestScore) {
                bestScore = score;
                best = lv.toImmutable();
            }
        }
        return best;
    }

    private BlockPos findDryStandingSpotForLava(ClientPlayerEntity player, ClientWorld world, BlockPos lavaPos) {
        BlockPos best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        BlockPos feet = player.getBlockPos();
        for (int dy = 1; dy <= 2; dy++) {
            int standY = lavaPos.getY() + dy;
            for (int dx = -2; dx <= 2; dx++) {
                for (int dz = -2; dz <= 2; dz++) {
                    if (dx == 0 && dz == 0) continue;
                    int distSq = dx * dx + dz * dz;
                    if (distSq > 5) continue;
                    BlockPos cand = new BlockPos(lavaPos.getX() + dx, standY, lavaPos.getZ() + dz);
                    if (!isSafeStandingCell(world, cand)) continue;
                    // Don't stand on our active water source cell!
                    if (cand.equals(activeWaterPos)) continue;
                    double dPlayer = Math.sqrt(cand.getSquaredDistance(feet));
                    // Strongly prefer directly adjacent dry rim cells (distSq <= 2) at poolY+1 so no intermediate curb occludes the lava!
                    double adjPenalty = distSq <= 2 ? 0.0 : 3.5;
                    double wetPenalty = world.getBlockState(cand).getFluidState().isEmpty() ? 0.0 : 4.0;
                    double elevPenalty = (dy - 1) * 1.6;
                    double score = dPlayer + Math.sqrt(distSq) * 0.8 + adjPenalty + wetPenalty + elevPenalty;
                    if (score < bestScore) {
                        bestScore = score;
                        best = cand;
                    }
                }
            }
        }
        return best;
    }

    private boolean isJumpingOntoStep(ClientPlayerEntity player) {
        if (site == null) return false;
        boolean needStep = stage == Stage.PLACE_S8 || stage == Stage.PLACE_S9
            || stage == Stage.WATER_LINTEL1 || stage == Stage.WATER_LINTEL2
            || stage == Stage.RECLAIM_LINTEL1 || stage == Stage.RECLAIM_LINTEL2;
        return needStep && player.getBlockY() <= site.s7().getY();
    }

    private static boolean isDirectlyAdjacentToLava(ClientWorld world, BlockPos feet) {
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                if (dx == 0 && dz == 0) continue;
                if (world.getBlockState(feet.add(dx, -1, dz)).getFluidState().isIn(FluidTags.LAVA)
                        || world.getBlockState(feet.add(dx, 0, dz)).getFluidState().isIn(FluidTags.LAVA)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isSafeStandingCell(ClientWorld world, BlockPos feetPos) {
        BlockState floor = world.getBlockState(feetPos.down());
        BlockState body = world.getBlockState(feetPos);
        BlockState head = world.getBlockState(feetPos.up());
        boolean bodyOk = (body.isAir() && body.getFluidState().isEmpty()) || body.getFluidState().isIn(FluidTags.WATER);
        return Perception.isSolidSupport(floor)
            && !floor.isOf(Blocks.OBSIDIAN)
            && bodyOk
            && head.isAir() && head.getFluidState().isEmpty();
    }

    private static boolean isNearLavaPos(ClientWorld world, BlockPos feet) {
        for (Direction d : HORIZONTALS) {
            if (world.getBlockState(feet.offset(d).down()).getFluidState().isIn(FluidTags.LAVA)
                    || world.getBlockState(feet.offset(d)).getFluidState().isIn(FluidTags.LAVA)) {
                return true;
            }
        }
        return false;
    }

    private static BlockPos findNearbyStillWater(ClientWorld world, BlockPos center, int radius) {
        if (center == null) return null;
        for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -radius; dx <= radius; dx++) {
                for (int dz = -radius; dz <= radius; dz++) {
                    BlockPos p = center.add(dx, dy, dz);
                    if (isStillWater(world, p)) return p;
                }
            }
        }
        return null;
    }

    private static boolean isStillWater(ClientWorld world, BlockPos pos) {
        var fs = world.getBlockState(pos).getFluidState();
        return fs.isIn(FluidTags.WATER) && fs.isStill();
    }

    private static boolean isStillLava(ClientWorld world, BlockPos pos) {
        var fs = world.getBlockState(pos).getFluidState();
        return fs.isIn(FluidTags.LAVA) && fs.isStill();
    }

    private static boolean hasWaterForObsidian(ClientWorld world, BlockPos targetCell) {
        if (world.getBlockState(targetCell).getFluidState().isIn(FluidTags.WATER)) return true;
        if (world.getBlockState(targetCell.up()).getFluidState().isIn(FluidTags.WATER)) return true;
        for (Direction d : HORIZONTALS) {
            if (world.getBlockState(targetCell.offset(d)).getFluidState().isIn(FluidTags.WATER)) return true;
        }
        return false;
    }

    private int ensureItemInHotbar(ClientPlayerEntity player, Item item) {
        int slot = motor.findHotbarItem(item);
        if (slot >= 0) return slot;
        if (GuiHands.countItem(player, item) > 0 && !gui.isBusy()) {
            gui.startHotbarSwap(st -> st.isOf(item));
        }
        return -1;
    }

    private int ensureCobbleHotbar(ClientPlayerEntity player) {
        Item[] order = { Items.COBBLESTONE, Items.COBBLED_DEEPSLATE, Items.DIRT };
        for (Item item : order) {
            int slot = motor.findHotbarItem(item);
            if (slot >= 0) return slot;
        }
        if (countSupportBlocks(player) > 0 && !gui.isBusy()) {
            gui.startHotbarSwap(st -> st.isOf(Items.COBBLESTONE) || st.isOf(Items.COBBLED_DEEPSLATE) || st.isOf(Items.DIRT));
        }
        return -1;
    }
}
