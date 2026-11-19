package io.gameharness.survival;

import static io.gameharness.survival.AgentPortal.REACH;
import static io.gameharness.survival.AgentPortal.facePoint;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.world.World;

/** One-bucket Java shore cast. Coordinates below are from the pool, looking back toward shore. */
final class AgentShoreCast {
    static final int MINIMUM_LAVA_POURS = 8;
    private static final int MINIMUM_FILLER = 9; // Including optional side footing and lintel rehydration support.
    private static final int FLOW_SETTLE = 35;
    private static final double SURVEY_REACH = 5.75;
    private static final Predicate<ItemStack> BUCKET = item(Items.BUCKET);
    private static final Predicate<ItemStack> WATER = item(Items.WATER_BUCKET);
    private static final Predicate<ItemStack> LAVA = item(Items.LAVA_BUCKET);
    private static final Predicate<ItemStack> STEEL = item(Items.FLINT_AND_STEEL);
    private static final Predicate<ItemStack> PICK = stack -> stack.isOf(Items.STONE_PICKAXE)
        || stack.isOf(Items.IRON_PICKAXE) || stack.isOf(Items.DIAMOND_PICKAXE);
    private static final Predicate<ItemStack> BREAKER = stack -> PICK.test(stack) || stack.isOf(Items.STONE_SHOVEL)
        || stack.isOf(Items.IRON_SHOVEL);

    private record Cell(int x, int y, int z) {}
    private record Layout(BlockPos edge, Direction shore) {
        Direction across() { return shore.rotateYClockwise(); }
        BlockPos at(Cell cell) { return at(cell.x, cell.y, cell.z); }
        BlockPos at(int x, int y, int z) {
            return edge.offset(across(), x).offset(shore, -z).up(y);
        }
    }
    private record Proof(BlockPos pos, String kind) {}
    private record Source(BlockPos pos, Vec3d point) {}
    record Report(String phase, BlockPos target, String check, String observed, int sources, int neededSources,
            int minimumLavaPours, int lavaScoopReceipts, int lavaPourReceipts, int waterPourReceipts,
            int waterRecoveryReceipts, Set<BlockPos> pouredFrameCells, Set<BlockPos> passiveFrameCells) {}

    private enum Phase {
        IDLE, SURVEY_EDGE, BANK, SURVEY_RESERVE, SUPPLY, PLUG, BASE_WATER, UNPLUG, STRIP,
        SIDE_FOOTING, CROSS, EXCAVATE, SCOOP, POUR, TOWER, DAM, NOTCH, RECOVER_BASE,
        UPPER_WATER, LINTEL_CHECK, RECOVER_UPPER, LINTEL_SUPPORT, LINTEL_WATER, RECOVER_FINAL, DRAIN, VERIFY,
        COMPLETE, DECLINED, BLOCKED
    }

    private static final Cell PLUG = new Cell(2, 0, 0);
    private static final Cell BASE_WATER = new Cell(1, 0, 0);
    private static final Cell UPPER_WATER = new Cell(2, 3, -1);
    private static final Cell LINTEL_WATER = new Cell(1, 3, -1);
    private static final Cell BYPASS = new Cell(0, 0, 1);
    private static final Cell APPROACH = new Cell(1, 1, 1);
    private static final Cell[] PASSIVE = {
        new Cell(0, 0, 0), new Cell(3, 0, 0), new Cell(1, 0, 1), new Cell(2, 0, 1)
    };
    private static final Cell[] TOWER = {
        new Cell(3, 1, -1), new Cell(3, 2, -1), new Cell(3, 3, -1), new Cell(3, 3, 0)
    };
    private static final Cell[] DAM = { new Cell(0, 1, -1), new Cell(1, 1, -1) };
    private static final Cell[] NOTCH = { new Cell(2, 1, -1), new Cell(2, 1, -2) };
    private static final Cell[] CROSS = {
        new Cell(0, 1, -1), new Cell(0, 1, 0), new Cell(0, 1, 1), APPROACH
    };
    private static final Cell[] CASTS = {
        new Cell(1, -1, 0), new Cell(2, -1, 0),
        new Cell(3, 1, 0), new Cell(3, 2, 0), new Cell(0, 1, 0), new Cell(0, 2, 0),
        new Cell(2, 3, 0), new Cell(1, 3, 0)
    };
    private static final Direction[] WATER_CONTACT = {
        Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.WEST, Direction.EAST
    };
    private static final double[] FACE_OFFSETS = {0.30, 0, -0.30};
    private static final int[] YAW_SWEEP = {0, -36, 36, -62, 62};
    private static final int[] LEFT_INDEX = {1, 2, 0, 3};

    private final MinecraftClient client;
    private final AgentBody body;
    private final AgentHands hands;
    private final AgentPortal portal;
    private final Set<Proof> evidence = new HashSet<>();
    private final Set<BlockPos> poured = new HashSet<>();
    private final Set<BlockPos> passive = new HashSet<>();
    private final Set<BlockPos> sources = new HashSet<>();
    private final Set<BlockPos> scooped = new HashSet<>();
    private final Set<BlockPos> missedScoops = new HashSet<>();
    private final List<BlockPos> missedBanks = new ArrayList<>();

    private Phase phase = Phase.IDLE;
    private String status = "looking for a straight four-cell lava shore";
    private String check = "";
    private String observed = "";
    private BlockPos target;
    private BlockPos anchor;
    private BlockPos initialLava;
    private Direction firstShore;
    private Layout layout;
    private BlockPos water;
    private Block plug;
    private Source pickup;
    private boolean destinationSeen;
    private boolean contactSeen;
    private boolean lavaDebited;
    private int tick;
    private int since;
    private int deadline;
    private int surveyEnd;
    private int nextProbe;
    private int candidate;
    private int index;
    private int cast;
    private int scan;
    private int visibleMask;
    private int faceChoice;
    private int faceMissSince;
    private int pickupSince;
    private int usedAt;
    private int fullBefore;
    private int emptyBefore;
    private int scoopReceipts;
    private int pourReceipts;
    private int waterPours;
    private int waterRecoveries;
    private int coveredAt;
    private int mineAt;
    private Placement blockUse;
    private BlockPos movingTo;
    private Vec3d strideOrigin;
    private boolean strideProved;

    private static final class Placement {
        final BlockPos dest;
        final BlockPos support;
        final Direction face;
        final Item item;
        final Block block;
        final boolean leap;
        final boolean lavaOutline;
        boolean wasAirborne;
        Placement(BlockPos dest, Direction face, Item item, boolean leap, boolean lavaOutline) {
            this.dest = dest;
            this.support = dest.offset(face.getOpposite());
            this.face = face;
            this.item = item;
            this.block = ((BlockItem) item).getBlock();
            this.leap = leap;
            this.lavaOutline = lavaOutline;
        }
    }

    AgentShoreCast(MinecraftClient client, AgentBody body, AgentHands hands, AgentPortal portal) {
        this.client = client;
        this.body = body;
        this.hands = hands;
        this.portal = portal;
    }

    boolean eligible() {
        if (phase != Phase.IDLE && phase != Phase.DECLINED) return true;
        var player = client.player;
        if (player == null || client.world == null || !World.OVERWORLD.equals(client.world.getRegistryKey())
                || player.age < nextProbe || !dryGround() || !has(PICK)
                || !has(WATER) && !has(BUCKET) || !has(STEEL)
                    && (!has(item(Items.FLINT)) || !has(item(Items.IRON_INGOT)))) return false;
        nextProbe = player.age + 8;
        BlockPos feet = player.getBlockPos();
        if (Math.abs(player.getY() - feet.getY()) > 0.07) return false;
        for (BlockPos missed : missedBanks) if (feet.getSquaredDistance(missed) <= 9) return false;
        BlockHitResult sighting = body.visibleFluid(true, true, REACH);
        if (sighting == null || !lavaSource(state(sighting))) return false;
        initialLava = sighting.getBlockPos();
        if (initialLava.getY() != feet.getY() - 1) return false;
        anchor = feet;
        Vec3d direction = sighting.getPos().subtract(player.getPos());
        firstShore = Direction.fromHorizontalDegrees(heading(direction)).getOpposite();
        sources.clear();
        rememberSource(sighting);
        candidate = 0;
        layout = null;
        phase = Phase.SURVEY_EDGE;
        return true;
    }

    String status() { return status; }
    String phaseName() { return phase.name(); }
    int confirmedFrameBlocks() { return poured.size() + passive.size(); }
    int passiveFrameBlocks() { return passive.size(); }
    int depositedLavaSources() { return pourReceipts; }
    long surveyEvidence() { return evidence.size(); }
    int witnessedSources() { return sources.size(); }
    boolean blocked() { return phase == Phase.BLOCKED; }
    AgentPortal.Site completed() {
        return phase == Phase.COMPLETE
            ? new AgentPortal.Site(at(APPROACH), layout.shore, at(CASTS[0])) : null;
    }

    Report report() {
        return new Report(phase.name(), target, check, observed, layout == null ? 0 : reserveCount(), MINIMUM_LAVA_POURS,
            MINIMUM_LAVA_POURS, scoopReceipts, pourReceipts, waterPours, waterRecoveries,
            Set.copyOf(poured), Set.copyOf(passive));
    }

    void step(int now) {
        tick = now;
        if (phase == Phase.SURVEY_EDGE && layout == null) {
            surveyEnd = tick + 460;
            nextLayout("initial camera geometry");
        }
        if (phase == Phase.IDLE || phase == Phase.COMPLETE || phase == Phase.DECLINED || phase == Phase.BLOCKED) return;
        if (tick > deadline) {
            if (phase == Phase.SURVEY_EDGE) nextLayout("unproved " + check + " at " + target + ": " + observed);
            else if (phase == Phase.BANK || phase == Phase.SURVEY_RESERVE) decline("geometry could not prove " + check);
            else block("timed out");
            return;
        }
        switch (phase) {
            case SURVEY_EDGE -> surveyEdge();
            case BANK -> {
                status = "walking up the dry bank to the observed pool";
                if (move(layout.at(1, 1, -1), false)) {
                    scan = 0;
                    change(Phase.SURVEY_RESERVE, 180);
                }
            }
            case SURVEY_RESERVE -> reserve();
            case SUPPLY -> prepare();
            case PLUG -> {
                status = "placing the temporary block in the pool edge";
                if (place(at(PLUG), Direction.UP, false, true)) {
                    plug = blockUse.block;
                    change(Phase.BASE_WATER, 110);
                }
            }
            case BASE_WATER -> {
                status = "placing water against the temporary block";
                if (usedAt == 0) hands.equipForUse(WATER);
                if (usedAt == 0 && !initialWaterCell()) return;
                if (pourWater(at(BASE_WATER), layout.across().getOpposite())) {
                    coveredAt = tick;
                    change(Phase.UNPLUG, 120);
                }
            }
            case UNPLUG -> {
                status = "breaking the plug to open the two-cell casting trough";
                if (tick - coveredAt >= 9 && dig(at(PLUG), plug, PICK)) {
                    index = 0;
                    change(Phase.STRIP, 85);
                }
            }
            case STRIP -> confirmStrip();
            case SIDE_FOOTING -> sideFooting();
            case CROSS -> {
                status = "walking the verified corner onto the new obsidian strip";
                if (move(at(CROSS[index]), index == 2)) {
                    if (++index == CROSS.length) {
                        cast = 0;
                        change(Phase.EXCAVATE, 125);
                    } else deadline = tick + 105;
                }
            }
            case EXCAVATE -> {
                status = "excavating trough floor " + (cast + 1) + "/2 with a pickaxe";
                if (dig(at(CASTS[cast]), null, PICK)) startScoop();
            }
            case SCOOP -> scoop();
            case POUR -> castLava();
            case TOWER -> buildTower();
            case DAM -> buildDam();
            case NOTCH -> openNotch();
            case RECOVER_BASE -> {
                status = "reclaiming the original trough water";
                if (recoverWater()) change(Phase.UPPER_WATER, 120);
            }
            case UPPER_WATER -> {
                status = "rehoming the same water source beside the top of the rear tower";
                if (pourWater(at(UPPER_WATER), layout.across().getOpposite())) startScoop();
            }
            case LINTEL_CHECK -> {
                status = "checking that the supplied water reaches the far lintel";
                if (verifyContact(at(CASTS[cast]))) startScoop();
                else if (tick - since >= 40) change(Phase.RECOVER_UPPER, 112);
            }
            case RECOVER_UPPER -> {
                status = "reclaiming the upper source to rehydrate the far lintel cell";
                if (recoverWater()) change(Phase.LINTEL_SUPPORT, 105);
            }
            case LINTEL_SUPPORT -> {
                status = "adding one side support to move water behind the far lintel";
                if (place(at(UPPER_WATER), layout.across().getOpposite(), false, false)) {
                    change(Phase.LINTEL_WATER, 110);
                }
            }
            case LINTEL_WATER -> {
                status = "moving the one source behind the far lintel";
                if (pourWater(at(LINTEL_WATER), layout.across().getOpposite())) startScoop();
            }
            case RECOVER_FINAL -> {
                status = "recovering the upper source so the portal can drain";
                if (recoverWater()) change(Phase.DRAIN, 105);
            }
            case DRAIN -> {
                status = "letting the two-cell opening drain";
                if (tick - since >= FLOW_SETTLE && move(at(APPROACH), false)) {
                    change(Phase.VERIFY, 72);
                }
            }
            case VERIFY -> verify();
            case IDLE, COMPLETE, DECLINED, BLOCKED -> {}
        }
    }

    private void nextLayout(String reason) {
        if (tick > surveyEnd || candidate >= 4 * 3 * LEFT_INDEX.length) {
            decline(reason);
            return;
        }
        int option = candidate++;
        int turn = option / (3 * LEFT_INDEX.length);
        Direction shore = switch (turn) {
            case 1 -> firstShore.rotateYClockwise();
            case 2 -> firstShore.rotateYCounterclockwise();
            case 3 -> firstShore.getOpposite();
            default -> firstShore;
        };
        Direction pool = shore.getOpposite();
        Vec3d delta = Vec3d.ofCenter(initialLava).subtract(Vec3d.ofCenter(anchor));
        int likelyDepth = MathHelper.clamp((int) delta.dotProduct(Vec3d.of(pool.getVector())), 1, 3);
        int depth = 1 + (likelyDepth - 1 + option / LEFT_INDEX.length % 3) % 3;
        int fromLeft = LEFT_INDEX[option % LEFT_INDEX.length];
        BlockPos edge = anchor.down().offset(pool, depth).offset(shore.rotateYClockwise().getOpposite(), fromLeft);
        layout = new Layout(edge, shore);
        index = 0;
        change(Phase.SURVEY_EDGE, 45);
    }

    private void surveyEdge() {
        status = "checking visible four-wide shore, plug, and future obsidian footing";
        for (int i = 0; i < 10; ++i) {
            int bit = 1 << i;
            if ((visibleMask & bit) != 0) continue;
            BlockPos pos = surveyCell(i);
            Vec3d point = surveyPoint(i, pos);
            BlockHitResult hit = i < 4 ? terrain(point, SURVEY_REACH) : fluid(point, SURVEY_REACH);
            if (matches(hit, pos) && (i < 4 ? hit.getSide() == Direction.UP && solid(hit) : lavaSource(state(hit)))) {
                if (i < 4) witness(pos, "bank floor");
                else rememberSource(hit);
                visibleMask |= bit;
                deadline = tick + 44;
            } else if (hit != null && body.aligned(point)) {
                nextLayout("expected " + (i < 4 ? "dry top" : "lava source") + "; saw " + describe(hit));
                return;
            }
        }
        if (visibleMask == 0x3ff) {
            change(Phase.BANK, 130);
            return;
        }
        // First get a single ordinary pool-facing look. Just inspect the parts
        // outside that view individually if the overview could not prove all ten.
        if (tick - since < 22) {
            body.turnScan(heading(Vec3d.of(layout.shore.getOpposite().getVector())), 43);
            return;
        }
        int missing = Integer.numberOfTrailingZeros(~visibleMask);
        BlockPos pos = surveyCell(missing);
        expect(pos, missing < 4 ? "flat, safe dry bank" : "visible original lava source");
        body.aim(surveyPoint(missing, pos));
    }

    private BlockPos surveyCell(int i) {
        return i < 4 ? layout.at(i, 0, -1) : i < 8 ? layout.at(i - 4, 0, 0) : at(PASSIVE[i - 6]);
    }

    private static Vec3d surveyPoint(int i, BlockPos pos) {
        return i < 4 ? facePoint(pos, Direction.UP) : Vec3d.ofCenter(pos, 0.73);
    }

    private void reserve() {
        status = "counting unreserved lava sources: " + reserveCount() + "/" + MINIMUM_LAVA_POURS;
        expect(layout.edge, "eight additional scoopable sources outside the trough and crossing");
        samplePool();
        if (reserveCount() >= MINIMUM_LAVA_POURS) {
            change(Phase.SUPPLY, 185);
            return;
        }
        float yaw = heading(Vec3d.of(layout.shore.getOpposite().getVector())) + YAW_SWEEP[scan];
        body.turn(yaw, 43);
        if (Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - yaw)) <= 5 && tick % 12 == 0)
            scan = (scan + 1) % YAW_SWEEP.length;
    }

    private void prepare() {
        if (portal.fillerCount() < MINIMUM_FILLER) {
            block("matching shore needs " + MINIMUM_FILLER + " compact casting blocks before modification; have "
                + portal.fillerCount());
            return;
        }
        if (!has(STEEL)) {
            status = "crafting flint and steel for the shore cast";
            hands.craft("flint_and_steel");
            return;
        }
        if (has(WATER)) {
            change(Phase.PLUG, 105);
            return;
        }
        status = "finding reachable source water before modifying the shore";
        if (pickup == null) {
            BlockHitResult hit = body.visibleFluid(false, true, REACH);
            if (hit != null && waterSource(state(hit))) pickup = new Source(hit.getBlockPos(), inward(hit));
            else body.turnScan(heading(Vec3d.of(layout.shore.getVector())) + (tick - since) / 26 * 60, 26);
            return;
        }
        useSource(pickup, false);
    }

    private boolean initialWaterCell() {
        BlockPos pos = at(BASE_WATER);
        Vec3d point = Vec3d.ofCenter(pos, 0.72);
        BlockHitResult hit = fluid(point, REACH);
        if (matches(hit, pos) && lavaSource(state(hit))) return true;
        expect(pos, "original neighboring lava before the initial water use");
        if (!aim(point)) return false;
        observe(hit);
        if (matches(hit, pos) && !lavaSource(state(hit))) block("neighboring water cell is no longer a lava source");
        return false;
    }

    private void confirmStrip() {
        status = "witnessing the two lava uprights and two standing cells cool";
        for (int i = 0; i < PASSIVE.length; ++i) {
            int bit = 1 << i;
            if ((visibleMask & bit) != 0) continue;
            BlockPos pos = at(PASSIVE[i]);
            BlockHitResult hit = terrain(Vec3d.ofCenter(pos, 0.9), REACH);
            if (!matches(hit, pos) || !state(hit).isOf(Blocks.OBSIDIAN) || waterPours != 1
                    || !evidence.contains(new Proof(pos, "visible lava source"))) continue;
            if (i < 2) passive.add(pos);
            witness(pos, "cooled by trough water");
            visibleMask |= bit;
            deadline = tick + 64;
        }
        if (visibleMask == 0xf) {
            index = 0;
            change(Phase.SIDE_FOOTING, 105);
            return;
        }
        BlockPos pos = at(PASSIVE[Integer.numberOfTrailingZeros(~visibleMask)]);
        expect(pos, "original lava source now obsidian after owned water pour");
        body.aim(Vec3d.ofCenter(pos, 0.90));
    }

    private void sideFooting() {
        status = "checking the low corner crossing to the obsidian standing strip";
        if (index < 2) {
            // The bank's lip blocks the shallow pool-floor outline at this angle.
            // First move along the bank and onto its freshly cooled outer corner.
            if (!move(at(CROSS[index]), index == 1)) return;
            deadline = tick + 110;
            if (++index < 2) return;
        }
        BlockPos pos = at(BYPASS);
        if (blockUse == null) {
            Vec3d point = Vec3d.ofCenter(pos, 0.92);
            expect(pos, "natural dry footing, or one placement into a shallow lava cell");
            if (!aim(point)) return;
            BlockHitResult hit = terrain(point, REACH);
            observe(hit);
            if (!matches(hit, pos)) return;
            if (solid(hit)) {
                beginCrossing();
                return;
            }
            if (!lavaSource(state(hit))) return;
        }
        if (place(pos, Direction.UP, false, true)) beginCrossing();
    }

    private void beginCrossing() {
        index = 2;
        change(Phase.CROSS, 110);
    }

    private void buildTower() {
        status = "building the rear three-block tower and one-block overhang";
        Direction face = index == 3 ? layout.shore.getOpposite() : Direction.UP;
        if (!place(at(TOWER[index]), face, index == 2, false)) return;
        if (++index == TOWER.length) {
            index = 0;
            change(Phase.DAM, 100);
        } else change(Phase.TOWER, 125);
    }

    private void buildDam() {
        status = "adding the two low rear dam blocks";
        if (!place(at(DAM[index]), Direction.UP, false, false)) return;
        if (++index == DAM.length) {
            index = 0;
            change(Phase.NOTCH, 110);
        } else change(Phase.DAM, 110);
    }

    private void openNotch() {
        status = "checking the low rear drain notch without breaking its floor";
        BlockPos pos = at(NOTCH[index]);
        Vec3d point = Vec3d.ofCenter(pos);
        expect(pos, "open rear drain above the bank floor");
        body.aim(point);
        if (!body.aligned(point) || !body.clearTerrain(point)) {
            BlockHitResult hit = terrain(point, REACH);
            observe(hit);
            if (!matches(hit, pos)) return;
            BlockState state = state(hit);
            if (!(state.isOf(Blocks.STONE) || state.isOf(Blocks.COBBLESTONE) || state.isOf(Blocks.DIRT)
                    || state.isOf(Blocks.GRASS_BLOCK) || state.isOf(Blocks.SAND) || state.isOf(Blocks.SANDSTONE)
                    || state.isOf(Blocks.GRAVEL))) {
                block("drain is obstructed by unsuitable terrain");
                return;
            }
            if (!dig(pos, state.getBlock(), BREAKER)) return;
        }
        witness(pos, "open rear drain");
        mineAt = 0;
        if (++index == NOTCH.length) change(Phase.RECOVER_BASE, 105);
        else deadline = tick + 125;
    }

    private void startScoop() {
        scan = 0;
        missedScoops.clear();
        change(Phase.SCOOP, 180);
    }

    private void scoop() {
        status = "scooping lava " + (cast + 1) + "/" + MINIMUM_LAVA_POURS + " for the compact frame";
        if (usedAt != 0 && count(LAVA) > fullBefore && count(BUCKET) < emptyBefore) {
            scooped.add(pickup.pos);
            witness(pickup.pos, "lava bucket inventory receipt");
            ++scoopReceipts;
            change(Phase.POUR, 145);
            return;
        }
        if (pickup != null) {
            if (tick - pickupSince < 32 || usedAt != 0 && tick - usedAt <= 14) {
                useSource(pickup, true);
                return;
            }
            missedScoops.add(pickup.pos);
            pickup = null;
            usedAt = 0;
        }
        // Turn straight to a previously witnessed source on a useful side. The
        // same rendered still-source and actual bucket-ray checks still gate the use.
        samplePool();
        pickup = bestSource();
        if (pickup != null) {
            pickupSince = tick;
            useSource(pickup, true);
            return;
        }
        float yaw = heading(Vec3d.of(layout.shore.getOpposite().getVector())) + YAW_SWEEP[scan];
        body.turnScan(yaw, 48);
        if (Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - yaw)) <= 5 && tick % 9 == 0)
            scan = (scan + 1) % YAW_SWEEP.length;
        expect(layout.edge, "unconsumed visible still lava within bucket reach");
        observed = reserveCount() + " distinct reserve sources witnessed before/during casting";
    }

    private Source bestSource() {
        var player = client.player;
        Vec3d eye = player.getEyePos();
        float towardCast = heading(cellPoint(at(CASTS[cast])).subtract(eye));
        BlockPos best = null;
        double bestCost = Double.POSITIVE_INFINITY;
        for (BlockPos pos : sources) {
            if (reserved(pos) || scooped.contains(pos) || missedScoops.contains(pos)) continue;
            Vec3d delta = Vec3d.ofCenter(pos, 0.70).subtract(eye);
            double distance = delta.lengthSquared();
            if (distance > REACH * REACH) continue;
            float yaw = heading(delta);
            // Prefer a smaller total turn out and back; cost still prefers a near source
            // where two routes need nearly the same turn.
            double cost = Math.abs(MathHelper.wrapDegrees(yaw - player.getYaw()))
                + Math.abs(MathHelper.wrapDegrees(yaw - towardCast)) + distance * 2.5;
            if (cost < bestCost) {
                best = pos;
                bestCost = cost;
            }
        }
        return best == null ? null : new Source(best, Vec3d.ofCenter(best, 0.70));
    }

    private void castLava() {
        BlockPos dest = at(CASTS[cast]);
        status = "casting compact obsidian " + (confirmedFrameBlocks() + 1) + "/10";
        if (usedAt != 0 && count(LAVA) < fullBefore && count(BUCKET) > emptyBefore) {
            if (!lavaDebited) {
                lavaDebited = true;
                ++pourReceipts;
                witness(dest, "lava bucket inventory debit");
            }
            expect(dest, "lava inventory debit and new visible obsidian at the same frame cell");
            Vec3d point = cellPoint(dest);
            BlockHitResult hit = terrain(point, REACH);
            observe(hit);
            if (!matches(hit, dest) || !state(hit).isOf(Blocks.OBSIDIAN)) {
                body.aim(point);
                return;
            }
            if (!poured.add(dest)) {
                block("duplicate cast proof");
                return;
            }
            witness(dest, "lava poured and newly cooled");
            if (++cast == CASTS.length) {
                change(Phase.RECOVER_FINAL, 110);
            } else if (cast == 1) change(Phase.EXCAVATE, 125);
            else if (cast == 2) {
                index = 0;
                change(Phase.TOWER, 115);
            } else if (cast == 7) {
                // The upper source can fan sideways after the near lintel redirects it.
                // Move the one source only if that wing never wets the far lintel.
                change(Phase.LINTEL_CHECK, 60);
            } else startScoop();
            return;
        }
        if (usedAt == 0 && !contactSeen) {
            if (!destinationSeen) {
                Vec3d point = cellPoint(dest);
                expect(dest, "open or flowing-water destination before lava pour");
                if (!body.clearTerrainThroughWater(point)) {
                    body.aim(point);
                    observe(terrain(point, REACH));
                    return;
                }
                destinationSeen = true;
            }
            if (!verifyContact(dest)) return;
        }
        Direction face = cast >= 6 ? layout.across().getOpposite() : Direction.UP;
        useAgainst(dest, face, LAVA);
    }

    private boolean verifyContact(BlockPos dest) {
        expect(dest, "visible cooling water beside or above the prospective obsidian");
        String firstWater = null;
        for (Direction side : WATER_CONTACT) {
            BlockPos pos = dest.offset(side);
            Vec3d point = Vec3d.ofCenter(pos, 0.52);
            BlockHitResult hit = fluid(point, REACH);
            boolean wetHit = hit != null && state(hit).getFluidState().isIn(FluidTags.WATER);
            if (wetHit && firstWater == null) firstWater = describe(hit);
            // A falling sheet can occlude its own ray though the actual neighbor is visibly wet.
            // Probe lit points through water only; opaque blocks still veto the observation.
            Vec3d low = Vec3d.ofCenter(pos, 0.08);
            if (wetHit && matches(hit, pos)
                    || body.visibleWaterAt(low, REACH)
                    || body.visibleWaterAt(low.add(Vec3d.of(layout.shore.getVector()).multiply(0.29)), REACH)) {
                contactSeen = true;
                witness(dest, "adjacent cooling water");
                return true;
            }
        }
        // The side adjacent to a downcast can be below the picture while its solid
        // destination is centered. Turn naturally to look at the appropriate water column.
        Direction expected = cast < 2 ? Direction.UP
            : cast < 4 ? layout.across().getOpposite()
            : cast < 6 ? layout.across() : layout.shore;
        body.aim(Vec3d.ofCenter(dest.offset(expected), 0.48));
        observed = firstWater == null ? "no visible water contact" : "water visible but not at a contact: " + firstWater;
        return false;
    }

    private boolean pourWater(BlockPos dest, Direction face) {
        if (usedAt != 0 && count(WATER) < fullBefore && count(BUCKET) > emptyBefore) {
            Vec3d point = Vec3d.ofCenter(dest, 0.69);
            expect(dest, "water inventory debit and a visible still source at the intended cell");
            BlockHitResult hit = fluid(point, REACH);
            observe(hit);
            if (!matches(hit, dest) || !waterSource(state(hit))) {
                body.aim(point);
                return false;
            }
            water = dest;
            ++waterPours;
            witness(dest, "owned water source placed");
            return true;
        }
        useAgainst(dest, face, WATER);
        return false;
    }

    private boolean recoverWater() {
        if (water == null) {
            block("lost the owned water source position");
            return false;
        }
        if (usedAt != 0 && count(WATER) > fullBefore && count(BUCKET) < emptyBefore) {
            ++waterRecoveries;
            witness(water, "owned source reclaimed into the bucket");
            water = null;
            return true;
        }
        Vec3d point = Vec3d.ofCenter(water, 0.70);
        if (water.getY() > layout.edge.getY() && (tick - since) / 17 % 3 != 1) {
            // Once the lintel is in place, look through the doorway and reach the low back
            // of the upper source; aiming at its center can hit the new lintel instead.
            point = Vec3d.ofCenter(water, 0.12)
                .add(Vec3d.of(layout.shore.getVector()).multiply(0.35));
        }
        useSource(new Source(water, point), false);
        return false;
    }

    private void useSource(Source source, boolean lava) {
        expect(source.pos, lava ? "targeted source-only lava bucket ray" : "targeted source-only water bucket ray");
        body.aimFine(source.point);
        AgentBody.Preparation readiness = usePreparation(BUCKET, 7);
        BlockHitResult hit = fluid(source.point, REACH);
        observe(hit);
        boolean exact = matches(hit, source.pos) && (lava ? lavaSource(state(hit)) : waterSource(state(hit)));
        // Flowing water can obscure another water block in the perception ray. The actual
        // bucket key is still accepted only by AgentBody's current exact SOURCE_ONLY ray.
        if (!exact && (lava || !body.visibleWaterAt(source.point, REACH))) return;
        if (!(lava ? body.useLavaSource(source.pos, source.point, readiness)
                : body.useWaterSource(source.pos, source.point, readiness))) return;
        if (usedAt == 0) {
            fullBefore = count(lava ? LAVA : WATER);
            emptyBefore = count(BUCKET);
        }
        usedAt = tick;
    }

    private void useAgainst(BlockPos dest, Direction face, Predicate<ItemStack> contents) {
        BlockPos support = dest.offset(face.getOpposite());
        expect(dest, "vanilla " + face + " face of " + support + " for bucket placement");
        AgentBody.Preparation readiness = usePreparation(contents, 21);
        BlockHitResult hit = workFace(support, face, true);
        if (hit == null) return;
        body.aimContact(hit, AgentBody.Contact.BUCKET);
        if (client.player.getBoundingBox().expand(0.18).intersects(new Box(dest))) {
            observed = "the actor would overlap the fluid placement; keeping the clear stance";
            body.vetoContact("collision_veto");
            return;
        }
        if (!body.useContact(hit, AgentBody.Contact.BUCKET, readiness)) return;
        fullBefore = count(contents);
        emptyBefore = count(BUCKET);
        usedAt = tick;
    }

    private boolean place(BlockPos dest, Direction face, boolean leap, boolean lavaOutline) {
        if (blockUse == null) {
            Item filler = portal.fillerItem();
            if (filler == null) {
                block("no solid casting block remains");
                return false;
            }
            blockUse = new Placement(dest, face, filler, leap, lavaOutline);
        }
        Placement work = blockUse;
        if (usedAt != 0 && count(item(work.item)) < fullBefore) {
            expect(dest, "block inventory debit and visible placement");
            Vec3d point = cellPoint(dest);
            BlockHitResult hit = terrain(point, REACH);
            observe(hit);
            if (!matches(hit, dest) || !state(hit).isOf(work.block)) {
                body.aim(point);
                return false;
            }
            witness(dest, "placed compact support");
            return true;
        }
        Predicate<ItemStack> filler = item(work.item);
        AgentBody.Preparation readiness = usePreparation(filler, 21);
        expect(dest, "visible vanilla " + work.face + " placement face " + work.support);
        BlockHitResult hit = work.leap ? leapingFace(work, readiness) : workFace(work.support, work.face, work.lavaOutline);
        AgentBody.Contact mode = work.leap ? AgentBody.Contact.LEAP_PLACE
            : work.lavaOutline ? AgentBody.Contact.RIM : AgentBody.Contact.PLACE;
        if (hit == null) return false;
        body.aimContact(hit, mode);
        if (client.player.getBoundingBox().intersects(new Box(dest))) {
            body.vetoContact("collision_veto");
            return false;
        }
        if (!body.useContact(hit, mode, readiness)) return false;
        fullBefore = count(filler);
        usedAt = tick;
        return false;
    }

    private BlockHitResult leapingFace(Placement work, AgentBody.Preparation readiness) {
        var player = client.player;
        boolean grounded = player.isOnGround();
        if (!grounded) work.wasAirborne = true;
        else if (work.wasAirborne) {
            // Only try another sightline after a completed jump, never while tracking its apex.
            work.wasAirborne = false;
            faceChoice = (faceChoice + 1) % FACE_OFFSETS.length;
        }
        Vec3d point = actionPoint(work.support, work.face, faceChoice);
        body.aimFixed(point);
        BlockHitResult seen = terrain(point, REACH);
        observe(seen);
        if (solidFace(seen, work.support, work.face)) return seen;
        if (grounded && player.getEyePos().y < work.support.getY() + 1.06
                && body.aligned(point) && readiness == AgentBody.Preparation.READY) body.jump();
        return null;
    }

    private BlockHitResult workFace(BlockPos support, Direction face, boolean allowOutline) {
        BlockHitResult hit = body.selectedFace();
        observeOutline(hit);
        if (matches(hit, support) && hit.getSide() == face && (allowOutline
                || solidFace(terrain(inward(hit), REACH), support, face))) {
            faceMissSince = 0;
            return hit;
        }
        // Alternate sight probes only when the required face cannot be witnessed.
        // Once sighted, the common motor selects and holds an admitted interior.
        Vec3d point = actionPoint(support, face, faceChoice);
        BlockHitResult seen = terrain(point, REACH);
        if (solidFace(seen, support, face)) {
            faceMissSince = 0;
            return seen;
        }
        if (allowOutline) body.aimFine(point);
        else body.aim(point);
        if (!body.aligned(point)) return null;
        if (faceMissSince == 0) faceMissSince = tick;
        if (tick - faceMissSince >= 5) {
            faceChoice = (faceChoice + 1) % FACE_OFFSETS.length;
            faceMissSince = 0;
        }
        return null;
    }

    private boolean solidFace(BlockHitResult hit, BlockPos support, Direction face) {
        return matches(hit, support) && hit.getSide() == face && solid(hit);
    }

    private boolean dig(BlockPos pos, Block expected, Predicate<ItemStack> tool) {
        Vec3d point = cellPoint(pos);
        expect(pos, "observed ordinary pick target followed by a clear cell");
        body.aim(point);
        if (mineAt != 0 && body.aligned(point) && body.clearTerrainThroughWater(point)) {
            witness(pos, "opened by ordinary attack input");
            return true;
        }
        BlockHitResult hit = terrain(point, REACH);
        observe(hit);
        if (!matches(hit, pos)) return false;
        BlockState state = state(hit);
        if (expected != null && !state.isOf(expected) || expected == null && !solid(hit)
                || state.isOf(Blocks.OBSIDIAN) || state.isOf(Blocks.BEDROCK)) {
            block("excavation is obstructed by " + describe(hit));
            return false;
        }
        body.aimContact(hit, AgentBody.Contact.MINE);
        if (equipped(tool) && body.mine(hit) && mineAt == 0) mineAt = tick;
        return false;
    }

    private void verify() {
        status = "checking six dry doorway cells before igniting the witnessed frame";
        // Each frame cell already has a unique, visible conversion receipt; their
        // completed uprights can hide the feet from this stance. Vanilla ignition
        // is the final whole-frame test. Verify that none of its aperture stayed wet.
        for (int i = 0; i < 6; ++i) {
            int bit = 1 << i;
            if ((visibleMask & bit) != 0) continue;
            BlockPos pos = layout.at(1 + i % 2, i / 2, 0);
            Vec3d point = cellPoint(pos);
            BlockHitResult hit = fluid(point, REACH);
            if (matches(hit, pos) || !body.clearTerrain(point)) continue;
            witness(pos, "verified dry doorway");
            visibleMask |= bit;
            deadline = tick + 68;
        }
        if (visibleMask == 0x3f) {
            if (poured.size() != MINIMUM_LAVA_POURS || passive.size() != 2 || !has(WATER)) {
                block("frame does not have eight poured cells, two passive cells, and the recovered water bucket");
            } else {
                status = "finished the compact shore frame with eight pours and two passive obsidian cells";
                change(Phase.COMPLETE, 0);
            }
        } else {
            int missing = Integer.numberOfTrailingZeros(~visibleMask);
            BlockPos pos = layout.at(1 + missing % 2, missing / 2, 0);
            expect(pos, "dry unobstructed aperture");
            body.aim(cellPoint(pos));
        }
    }

    private boolean move(BlockPos feet, boolean narrow) {
        expect(feet, "dry supported stance reached with ordinary movement");
        var player = client.player;
        Vec3d goal = Vec3d.ofBottomCenter(feet);
        // Finish clear of the initial water placement's body margin even after
        // the last normal walking step coasts to a stop at the bank.
        if (phase == Phase.BANK) goal = goal.add(Vec3d.of(layout.shore.getVector()).multiply(0.20));
        Vec3d delta = goal.subtract(player.getPos());
        double distance = delta.horizontalLengthSquared();
        if (Math.abs(delta.y) > 0.22 || distance > 9 || !dryGround()) return false;
        if (distance < (narrow ? 0.18 * 0.18 : 0.23 * 0.23)) {
            witness(feet, "standing on proved floor");
            movingTo = null;
            return true;
        }
        if (!feet.equals(movingTo)) {
            movingTo = feet;
            strideOrigin = player.getPos();
            strideProved = false;
        }
        if (!strideProved) {
            Vec3d point = facePoint(feet.down(), Direction.UP);
            BlockHitResult floor = terrain(point, REACH);
            observe(floor);
            if (!matches(floor, feet.down()) || floor.getSide() != Direction.UP || !solid(floor)) {
                body.aimFixed(point);
                return false;
            }
            strideProved = true;
        }
        // Once proved, keep looking along this leg instead of repeatedly looking
        // straight down, recentering, and turning back. The motor still vetoes lava.
        float landingYaw = heading(delta);
        float yaw = heading(goal.subtract(strideOrigin));
        // Refit a leg only if it drifts off the landing. The body's exact-landing
        // braking window requires that the current heading actually meets it.
        if (Math.abs(MathHelper.wrapDegrees(landingYaw - yaw)) > 8) yaw = landingYaw;
        body.turnFixed(yaw, 33);
        if (Math.abs(MathHelper.wrapDegrees(player.getYaw() - landingYaw)) > 12) return false;
        if (narrow) body.sneak();
        body.walkDownTo(goal);
        return false;
    }

    private void samplePool() {
        for (int z = 0; z <= 5; ++z) {
            for (int x = -3; x <= 6; ++x) {
                BlockPos pos = layout.at(x, 0, z);
                if (sources.contains(pos)) continue;
                Vec3d point = Vec3d.ofCenter(pos, 0.74);
                if (point.squaredDistanceTo(client.player.getEyePos()) > REACH * REACH) continue;
                BlockHitResult hit = fluid(point, REACH);
                if (matches(hit, pos) && lavaSource(state(hit))) {
                    rememberSource(hit);
                }
            }
        }
    }

    private int reserveCount() {
        int count = 0;
        for (BlockPos pos : sources) if (!reserved(pos)) ++count;
        return count;
    }

    private boolean reserved(BlockPos pos) {
        return pos.equals(at(PLUG)) || pos.equals(at(BASE_WATER)) || pos.equals(at(BYPASS))
            || pos.equals(at(PASSIVE[0])) || pos.equals(at(PASSIVE[1]))
            || pos.equals(at(PASSIVE[2])) || pos.equals(at(PASSIVE[3]));
    }

    private void rememberSource(BlockHitResult hit) {
        sources.add(hit.getBlockPos());
        witness(hit.getBlockPos(), "visible lava source");
    }

    private void decline(String reason) {
        missedBanks.add(anchor);
        observed = reason;
        status = "straight-shore geometry not admitted: " + reason;
        change(Phase.DECLINED, 0);
    }

    private void block(String reason) {
        status = "compact shore cast blocked in " + phase + " at " + target + " (" + check + "): "
            + reason + "; observed " + observed + "; sources " + sources.size() + ", poured "
            + poured.size() + "/" + MINIMUM_LAVA_POURS + ", passive " + passive.size() + "/2";
        change(Phase.BLOCKED, 0);
    }

    private void change(Phase next, int allowance) {
        phase = next;
        since = tick;
        deadline = tick + allowance;
        usedAt = mineAt = 0;
        visibleMask = faceChoice = faceMissSince = 0;
        movingTo = null;
        pickup = null;
        blockUse = null;
        destinationSeen = contactSeen = lavaDebited = false;
    }

    private void expect(BlockPos pos, String description) {
        if (!pos.equals(target) || !description.equals(check)) observed = "awaiting a reachable, rendered face";
        target = pos;
        check = description;
    }

    private void observe(BlockHitResult hit) { observed = describe(hit); }
    private void observeOutline(BlockHitResult hit) {
        observed = hit == null ? "no rendered outline" : hit.getSide() + " outline at " + hit.getBlockPos();
    }
    private String describe(BlockHitResult hit) {
        return hit == null ? "no rendered hit" : hit.getSide() + " " + state(hit).getBlock() + " at " + hit.getBlockPos();
    }
    private boolean aim(Vec3d point) {
        body.aim(point);
        return body.aligned(point);
    }
    private Vec3d cellPoint(BlockPos pos) {
        // Bias downcast looks away from the strip's top edge to see the recess below it.
        return Vec3d.ofCenter(pos, 0.77).add(Vec3d.of(layout.shore.getVector()).multiply(0.30));
    }
    private Vec3d actionPoint(BlockPos support, Direction face, int offset) {
        Vec3d point = facePoint(support, face);
        if (face.getAxis().isVertical() || face.getAxis() == layout.across().getAxis())
            return point.add(Vec3d.of(layout.shore.getVector()).multiply(FACE_OFFSETS[offset]));
        return point.add(Vec3d.of(layout.across().getVector()).multiply(FACE_OFFSETS[offset]));
    }
    private boolean dryGround() {
        var player = client.player;
        return player.isOnGround() && !player.isTouchingWater() && !player.isInLava();
    }
    private BlockPos at(Cell cell) { return layout.at(cell); }
    private void witness(BlockPos pos, String kind) { evidence.add(new Proof(pos, kind)); }
    private BlockHitResult fluid(Vec3d point, double reach) { return body.perceive(point, reach).orElse(null); }
    private BlockHitResult terrain(Vec3d point, double reach) { return body.terrainThroughWater(point, reach).orElse(null); }
    private BlockState state(BlockHitResult hit) { return client.world.getBlockState(hit.getBlockPos()); }
    private boolean solid(BlockHitResult hit) {
        BlockState state = state(hit);
        return AgentPortal.usableSupport(state) && Block.isShapeFullCube(state.getCollisionShape(client.world, hit.getBlockPos()));
    }
    private boolean has(Predicate<ItemStack> item) { return count(item) > 0; }
    private boolean equipped(Predicate<ItemStack> item) {
        return hands.equipForUse(item);
    }
    private AgentBody.Preparation usePreparation(Predicate<ItemStack> item, int receiptTicks) {
        // Retry grace belongs to the outstanding input, not to the next job's press.
        if (usedAt != 0 && tick - usedAt < receiptTicks) return AgentBody.Preparation.RECEIPT;
        return AgentBody.Preparation.equipment(hands.equipForUse(item));
    }
    private int count(Predicate<ItemStack> item) { return hands.count(item); }
    private static Predicate<ItemStack> item(Item item) { return stack -> stack.isOf(item); }
    private static boolean matches(BlockHitResult hit, BlockPos pos) { return hit != null && hit.getBlockPos().equals(pos); }
    private static boolean lavaSource(BlockState state) {
        var fluid = state.getFluidState();
        return fluid.isIn(FluidTags.LAVA) && fluid.isStill();
    }
    private static boolean waterSource(BlockState state) {
        var fluid = state.getFluidState();
        return state.isOf(Blocks.WATER) && fluid.isIn(FluidTags.WATER) && fluid.isStill();
    }
    private static Vec3d inward(BlockHitResult hit) {
        return hit.getPos().lerp(Vec3d.ofCenter(hit.getBlockPos()), 0.035);
    }
    private static float heading(Vec3d delta) {
        return (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
    }
}
