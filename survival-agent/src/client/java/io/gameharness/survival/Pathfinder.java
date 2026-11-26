package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.FallingBlock;
import net.minecraft.block.LeavesBlock;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;

/**
 * Real 3D incremental A* pathfinder inspired by Baritone / Mine AI MCP.
 * Plans over genuinely observed blocks (Perception) plus explicit local terrain hypotheses
 * for underground excavation (unobserved cells ahead are modeled as diggable rock, never X-rayed).
 * Supports walk, sprint, diagonal movement, step-up, safe drops, canopy descent,
 * 1x2 tunnel & staircase digging, pillaring, bridging, and swimming.
 */
final class Pathfinder {
    private static final int MAX_EXPANSIONS = 3_500;
    private static final int MIN_PARTIAL_DIST_SQ = 9; // >= 3 blocks

    enum MoveKind {
        WALK, DIAGONAL, STEP_UP, DROP, DIG_WALK, STAIR_DOWN, DIG_DOWN, PILLAR, BRIDGE, SWIM
    }

    record Step(
        BlockPos from,
        BlockPos to,
        MoveKind kind,
        List<BlockPos> toBreak,
        List<BlockPos> toPlace,
        double cost
    ) {}

    record Plan(List<Step> steps, boolean complete, BlockPos bestNode) {
        boolean isEmpty() { return steps.isEmpty(); }
    }

    record Options(
        boolean allowDigging,
        boolean allowPlacing,
        boolean allowHypotheses,
        boolean allowFoliageDrop,
        boolean safeStaircase,
        int maxDrop,
        int scaffoldCount
    ) {
        static Options surface(int scaffolds, boolean healthy) {
            return new Options(true, scaffolds > 0, false, healthy, true, healthy ? 3 : 2, scaffolds);
        }

        static Options mining(int scaffolds, boolean healthy, boolean safeStaircase) {
            return new Options(true, scaffolds > 0, true, healthy, safeStaircase, healthy ? 3 : 2, scaffolds);
        }

        static Options flee(int scaffolds) {
            return new Options(false, false, false, true, true, 3, scaffolds);
        }
    }

    interface Goal {
        boolean isSatisfied(int x, int y, int z);
        double heuristic(int x, int y, int z);

        static Goal near(BlockPos target, double range) {
            double rSq = range * range;
            return new Goal() {
                @Override public boolean isSatisfied(int x, int y, int z) {
                    double dx = x - target.getX(), dy = y - target.getY(), dz = z - target.getZ();
                    return dx * dx + dy * dy + dz * dz <= rSq;
                }
                @Override public double heuristic(int x, int y, int z) {
                    return ticksEstimate(x, y, z, target.getX(), target.getY(), target.getZ());
                }
            };
        }

        static Goal nearXZ(int tx, int tz, double range) {
            double rSq = range * range;
            return new Goal() {
                @Override public boolean isSatisfied(int x, int y, int z) {
                    double dx = x - tx, dz = z - tz;
                    return dx * dx + dz * dz <= rSq;
                }
                @Override public double heuristic(int x, int y, int z) {
                    return Math.hypot(x - tx, z - tz) * 4.5;
                }
            };
        }

        static Goal interactReach(BlockPos target, double maxReach) {
            double rSq = maxReach * maxReach;
            return new Goal() {
                @Override public boolean isSatisfied(int x, int y, int z) {
                    // Eye is at (x+0.5, y+1.62, z+0.5)
                    double dx = (x + 0.5) - (target.getX() + 0.5);
                    double dy = (y + 1.62) - (target.getY() + 0.5);
                    double dz = (z + 0.5) - (target.getZ() + 0.5);
                    // Avoid standing inside the target block itself
                    if (x == target.getX() && z == target.getZ() && (y == target.getY() || y + 1 == target.getY())) {
                        return false;
                    }
                    return dx * dx + dy * dy + dz * dz <= rSq;
                }
                @Override public double heuristic(int x, int y, int z) {
                    return Math.max(0.0, ticksEstimate(x, y, z, target.getX(), target.getY(), target.getZ()) - 10.0);
                }
            };
        }

        static Goal reachY(int targetY) {
            return new Goal() {
                @Override public boolean isSatisfied(int x, int y, int z) {
                    return y <= targetY;
                }
                @Override public double heuristic(int x, int y, int z) {
                    return y <= targetY ? 0.0 : (y - targetY) * 42.0;
                }
            };
        }

        static Goal awayFrom(BlockPos threat, double safeDist) {
            double sSq = safeDist * safeDist;
            return new Goal() {
                @Override public boolean isSatisfied(int x, int y, int z) {
                    double dx = x - threat.getX(), dz = z - threat.getZ();
                    return dx * dx + dz * dz >= sSq;
                }
                @Override public double heuristic(int x, int y, int z) {
                    double d = Math.hypot(x - threat.getX(), z - threat.getZ());
                    return Math.max(0.0, safeDist - d) * 5.0;
                }
            };
        }
    }

    static double ticksEstimate(int x1, int y1, int z1, int x2, int y2, int z2) {
        double dx = Math.abs(x2 - x1);
        double dz = Math.abs(z2 - z1);
        double diag = Math.min(dx, dz);
        double straight = Math.max(dx, dz) - diag;
        double horiz = (diag * 1.41421356 + straight) * 4.5;
        int dy = y2 - y1;
        double vert = dy > 0 ? dy * 12.0 : (-dy) * 12.0;
        return horiz + vert;
    }

    private static final class Node {
        final int x, y, z;
        final long key;
        double g;
        double h;
        double f;
        Node parent;
        Step viaStep;
        boolean closed;

        Node(int x, int y, int z, double g, double h) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.key = BlockPos.asLong(x, y, z);
            this.g = g;
            this.h = h;
            this.f = g + h;
        }
    }

    private static final int[][] CARDINALS = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    private static final int[][] DIAGONALS = {{1, 1}, {1, -1}, {-1, 1}, {-1, -1}};

    /** Run a fast bounded 3D A* search from `start` toward `goal`. */
    Plan search(Perception perception, ClientPlayerEntity player, BlockPos start, Goal goal, Options opts) {
        if (goal.isSatisfied(start.getX(), start.getY(), start.getZ())) {
            return new Plan(List.of(), true, start);
        }

        Map<Long, Node> nodes = new HashMap<>(1024);
        PriorityQueue<Node> open = new PriorityQueue<>(256, (a, b) -> Double.compare(a.f, b.f));

        // Weighted A* (Baritone-style heuristic weight) makes long 3D mining/staircase searches zoom straight to target!
        final double hWeight = opts.allowHypotheses ? 3.2 : 1.5;

        Node root = new Node(start.getX(), start.getY(), start.getZ(), 0.0,
            goal.heuristic(start.getX(), start.getY(), start.getZ()) * hWeight);
        nodes.put(root.key, root);
        open.add(root);

        Node bestPartial = root;
        double bestPartialScore = root.h;
        Node nearestAny = root;
        double nearestH = root.h;

        int expansions = 0;
        List<Step> neighbors = new ArrayList<>(24);

        while (!open.isEmpty() && expansions < MAX_EXPANSIONS) {
            Node cur = open.poll();
            if (cur.closed) continue;
            cur.closed = true;
            expansions++;

            if (goal.isSatisfied(cur.x, cur.y, cur.z)) {
                return new Plan(reconstruct(cur), true, new BlockPos(cur.x, cur.y, cur.z));
            }

            // Track best partial progress node (Baritone-style h + g / coeff)
            if (cur != root) {
                if (cur.h < nearestH) {
                    nearestH = cur.h;
                    nearestAny = cur;
                }
                int distSq = sq(cur.x - start.getX()) + sq(cur.y - start.getY()) + sq(cur.z - start.getZ());
                double score = cur.h + cur.g * 0.20;
                if (distSq >= MIN_PARTIAL_DIST_SQ && score < bestPartialScore) {
                    bestPartialScore = score;
                    bestPartial = cur;
                }
            }

            neighbors.clear();
            generateNeighbors(perception, player, cur.x, cur.y, cur.z, opts, neighbors);

            for (Step step : neighbors) {
                long nk = step.to().asLong();
                double ng = cur.g + step.cost();
                Node existing = nodes.get(nk);
                if (existing != null) {
                    if (existing.closed || ng >= existing.g - 1e-4) continue;
                    existing.g = ng;
                    existing.f = ng + existing.h;
                    existing.parent = cur;
                    existing.viaStep = step;
                    open.add(existing);
                } else {
                    double nh = goal.heuristic(step.to().getX(), step.to().getY(), step.to().getZ()) * hWeight;
                    Node next = new Node(step.to().getX(), step.to().getY(), step.to().getZ(), ng, nh);
                    next.parent = cur;
                    next.viaStep = step;
                    nodes.put(nk, next);
                    open.add(next);
                }
            }
        }

        Node chosen = bestPartial != root ? bestPartial : (nearestAny != root && nearestH < root.h - 0.5 ? nearestAny : null);
        if (chosen == null) {
            return new Plan(List.of(), false, start);
        }
        return new Plan(reconstruct(chosen), false, new BlockPos(chosen.x, chosen.y, chosen.z));
    }

    private static List<Step> reconstruct(Node end) {
        List<Step> steps = new ArrayList<>();
        Node cur = end;
        while (cur.parent != null && cur.viaStep != null) {
            steps.add(cur.viaStep);
            cur = cur.parent;
        }
        Collections.reverse(steps);
        return steps;
    }

    private void generateNeighbors(Perception p, ClientPlayerEntity player, int x, int y, int z, Options opts, List<Step> out) {
        BlockPos from = new BlockPos(x, y, z);
        BlockState feetHere = p.getObserved(x, y, z);
        BlockState belowHere = p.getObserved(x, y - 1, z);
        boolean inWater = feetHere != null && feetHere.getFluidState().isIn(FluidTags.WATER);
        boolean standingOnLeaves = belowHere != null && belowHere.getBlock() instanceof LeavesBlock;

        // 1. Cardinal moves: walk, dig-walk, step-up, drop, stair-down, bridge, swim
        for (int[] d : CARDINALS) {
            int nx = x + d[0];
            int nz = z + d[1];

            // 1a. Same-level walk / swim / dig-walk / bridge
            tryHorizontal(p, player, from, nx, y, nz, inWater, opts, out);

            // 1b. Step up (+1 Y)
            tryStepUp(p, player, from, nx, y + 1, nz, inWater, opts, out);

            // 1c. Descend / Drop (1..maxDrop down, or safe foliage drop up to 5 blocks)
            tryDropOrStairDown(p, player, from, nx, y, nz, standingOnLeaves, opts, out);
        }

        // 2. Diagonal moves (only when passable without digging, checking both corners so movement is smooth & 360-deg!)
        for (int[] d : DIAGONALS) {
            int nx = x + d[0];
            int nz = z + d[1];
            tryDiagonal(p, from, nx, y, nz, inWater, out);
        }

        // 3. Pillar up (+1 Y in place) when allowed
        if (opts.allowPlacing && opts.scaffoldCount > 0 && !inWater) {
            tryPillarUp(p, player, from, opts, out);
        }

        // 4. Straight down dig (only if !safeStaircase and digging enabled)
        if (opts.allowDigging && !opts.safeStaircase && !inWater) {
            tryDigStraightDown(p, player, from, opts, out);
        }
    }

    private void tryHorizontal(Perception p, ClientPlayerEntity player, BlockPos from, int nx, int y, int nz,
                               boolean inWater, Options opts, List<Step> out) {
        BlockState dstFeet = p.getObserved(nx, y, nz);
        BlockState dstHead = p.getObserved(nx, y + 1, nz);
        BlockState dstBelow = p.getObserved(nx, y - 1, nz);

        // Swim transition if destination feet is water (strongly penalized so mining/descent never dives into ponds/swamps!)
        if (dstFeet != null && dstFeet.getFluidState().isIn(FluidTags.WATER)
                && (dstHead == null || Perception.isPassable(dstHead))) {
            double swimCost = opts.allowDigging ? 48.0 : 22.0;
            out.add(new Step(from, new BlockPos(nx, y, nz), MoveKind.SWIM, List.of(), List.of(), swimCost));
            return;
        }

        // Open walk on observed solid ground
        if (dstFeet != null && dstHead != null && dstBelow != null
                && Perception.isPassable(dstFeet) && Perception.isPassable(dstHead)
                && Perception.isSolidSupport(dstBelow)) {
            double cost = inWater ? 8.5 : 4.2;
            out.add(new Step(from, new BlockPos(nx, y, nz), MoveKind.WALK, List.of(), List.of(), cost));
            return;
        }

        // Bridge over observed air/water gap (1 block) if placing allowed
        if (opts.allowPlacing && opts.scaffoldCount > 0 && !inWater
                && dstFeet != null && dstHead != null && dstBelow != null
                && Perception.isPassable(dstFeet) && Perception.isPassable(dstHead)
                && !Perception.isSolidSupport(dstBelow) && !Perception.isHazardBlock(dstBelow)) {
            out.add(new Step(from, new BlockPos(nx, y, nz), MoveKind.BRIDGE,
                List.of(), List.of(new BlockPos(nx, y - 1, nz)), 18.0));
            return;
        }

        // Dig-walk through solid or hypothesized rock (2-high tunnel!)
        if (!opts.allowDigging) return;
        boolean floorOk = dstBelow != null ? Perception.isSolidSupport(dstBelow) : opts.allowHypotheses;
        if (!floorOk) return;

        List<BlockPos> breaks = new ArrayList<>(2);
        double digCost = 0.0;
        double headCost = cellDigCost(p, player, nx, y + 1, nz, opts);
        if (headCost < 0) return;
        if (headCost > 0) { breaks.add(new BlockPos(nx, y + 1, nz)); digCost += headCost; }

        double feetCost = cellDigCost(p, player, nx, y, nz, opts);
        if (feetCost < 0) return;
        if (feetCost > 0) { breaks.add(new BlockPos(nx, y, nz)); digCost += feetCost; }

        if (breaks.isEmpty()) return;
        out.add(new Step(from, new BlockPos(nx, y, nz), MoveKind.DIG_WALK, breaks, List.of(), 6.0 + digCost));
    }

    private void tryStepUp(Perception p, ClientPlayerEntity player, BlockPos from, int nx, int ny, int nz,
                           boolean inWater, Options opts, List<Step> out) {
        BlockState dstBelow = p.getObserved(nx, ny - 1, nz);
        if (dstBelow == null) {
            if (!opts.allowHypotheses || !opts.allowDigging) return;
        } else if (!Perception.isSolidSupport(dstBelow)) {
            // Allow swimming out of water onto adjacent water top? Handled by swim.
            return;
        }

        List<BlockPos> breaks = new ArrayList<>(3);
        double digCost = 0.0;

        // Headroom above origin (x, y+2, z) must be clear to jump up
        double origTop = cellDigCost(p, player, from.getX(), from.getY() + 2, from.getZ(), opts);
        if (origTop < 0) return;
        if (origTop > 0) { breaks.add(new BlockPos(from.getX(), from.getY() + 2, from.getZ())); digCost += origTop; }

        double dstHead = cellDigCost(p, player, nx, ny + 1, nz, opts);
        if (dstHead < 0) return;
        if (dstHead > 0) { breaks.add(new BlockPos(nx, ny + 1, nz)); digCost += dstHead; }

        double dstFeet = cellDigCost(p, player, nx, ny, nz, opts);
        if (dstFeet < 0) return;
        if (dstFeet > 0) { breaks.add(new BlockPos(nx, ny, nz)); digCost += dstFeet; }

        if (!breaks.isEmpty() && !opts.allowDigging) return;
        double base = inWater ? 11.0 : 8.2;
        out.add(new Step(from, new BlockPos(nx, ny, nz), MoveKind.STEP_UP, breaks, List.of(), base + digCost));
    }

    private void tryDropOrStairDown(Perception p, ClientPlayerEntity player, BlockPos from, int nx, int y, int nz,
                                    boolean standingOnLeaves, Options opts, List<Step> out) {
        // First: check natural drop through already-open column (1..maxDrop, or up to 5 from leaves onto dry ground, or into water!)
        BlockState stepFeet = p.getObserved(nx, y, nz);
        BlockState stepHead = p.getObserved(nx, y + 1, nz);

        if (stepFeet != null && stepHead != null && Perception.isPassable(stepFeet) && Perception.isPassable(stepHead)) {
            int limit = standingOnLeaves && opts.allowFoliageDrop ? 5 : opts.maxDrop;
            for (int drop = 1; drop <= limit; drop++) {
                int ly = y - drop;
                BlockState at = p.getObserved(nx, ly, nz);
                if (at == null) break;
                if (at.getFluidState().isIn(FluidTags.WATER)) {
                    double waterDropCost = opts.allowDigging ? 55.0 : (16.0 + drop * 2.5);
                    out.add(new Step(from, new BlockPos(nx, ly, nz), MoveKind.DROP, List.of(), List.of(), waterDropCost));
                    return;
                }
                if (Perception.isHazardBlock(at)) return;
                if (Perception.isSolidSupport(at)) {
                    // Landed on solid at ly; feet are at ly + 1!
                    int landY = ly + 1;
                    if (landY < y) {
                        double fallPenalty = (y - landY) > 3 ? 16.0 : 0.0;
                        out.add(new Step(from, new BlockPos(nx, landY, nz), MoveKind.DROP, List.of(), List.of(),
                            6.5 + (y - landY) * 2.2 + fallPenalty));
                        return;
                    }
                    // Flat ground (landY == y): fall through to allow STAIR_DOWN excavation!
                    break;
                }
                if (!Perception.isPassable(at)) return;
            }
        }

        // Second: staircase excavation down by 1 block! (Clear (nx,y+1,nz), (nx,y,nz), (nx,y-1,nz) -> stand at (nx,y-1,nz) on (nx,y-2,nz))
        if (!opts.allowDigging) return;
        int ny = y - 1;
        BlockState floor = p.getObserved(nx, ny - 1, nz);
        boolean floorOk = floor != null ? Perception.isSolidSupport(floor) : opts.allowHypotheses;
        if (!floorOk) return;
        if (p.isNearKnownLava(nx, ny, nz) || p.isNearKnownLava(nx, ny - 1, nz)) return;

        List<BlockPos> breaks = new ArrayList<>(3);
        double digCost = 0.0;

        // Break top-to-bottom so headroom stays clear and sand/gravel is caught cleanly
        double cHead = cellDigCost(p, player, nx, y + 1, nz, opts);
        if (cHead < 0) return;
        if (cHead > 0) { breaks.add(new BlockPos(nx, y + 1, nz)); digCost += cHead; }

        double cMid = cellDigCost(p, player, nx, y, nz, opts);
        if (cMid < 0) return;
        if (cMid > 0) { breaks.add(new BlockPos(nx, y, nz)); digCost += cMid; }

        double cLow = cellDigCost(p, player, nx, ny, nz, opts);
        if (cLow < 0) return;
        if (cLow > 0) { breaks.add(new BlockPos(nx, ny, nz)); digCost += cLow; }

        if (breaks.isEmpty()) return;
        // Slightly favor staircases underground (clean, safe, walk-back-up capable!)
        out.add(new Step(from, new BlockPos(nx, ny, nz), MoveKind.STAIR_DOWN, breaks, List.of(), 7.5 + digCost));
    }

    private void tryDiagonal(Perception p, BlockPos from, int nx, int y, int nz, boolean inWater, List<Step> out) {
        if (inWater) return;
        BlockState dstFeet = p.getObserved(nx, y, nz);
        BlockState dstHead = p.getObserved(nx, y + 1, nz);
        BlockState dstBelow = p.getObserved(nx, y - 1, nz);
        if (dstFeet == null || dstHead == null || dstBelow == null) return;
        if (!Perception.isPassable(dstFeet) || !Perception.isPassable(dstHead) || !Perception.isSolidSupport(dstBelow)) return;
        if (!dstFeet.getFluidState().isEmpty()) return;

        // Both orthogonal corner columns must be passable so body hitbox doesn't snag
        int x = from.getX(), z = from.getZ();
        if (!columnClear(p, nx, y, z) || !columnClear(p, x, y, nz)) return;

        out.add(new Step(from, new BlockPos(nx, y, nz), MoveKind.DIAGONAL, List.of(), List.of(), 4.2 * 1.41421356));
    }

    private void tryPillarUp(Perception p, ClientPlayerEntity player, BlockPos from, Options opts, List<Step> out) {
        int x = from.getX(), y = from.getY(), z = from.getZ();
        BlockState below = p.getObserved(x, y - 1, z);
        if (below == null || !Perception.isSolidSupport(below)) return;
        double headCost = cellDigCost(p, player, x, y + 2, z, opts);
        if (headCost < 0) return;
        List<BlockPos> breaks = headCost > 0 ? List.of(new BlockPos(x, y + 2, z)) : List.of();
        if (!breaks.isEmpty() && !opts.allowDigging) return;
        out.add(new Step(from, new BlockPos(x, y + 1, z), MoveKind.PILLAR, breaks, List.of(from), 18.0 + headCost));
    }

    private void tryDigStraightDown(Perception p, ClientPlayerEntity player, BlockPos from, Options opts, List<Step> out) {
        int x = from.getX(), y = from.getY(), z = from.getZ();
        BlockState below = p.getObserved(x, y - 1, z);
        BlockState below2 = p.getObserved(x, y - 2, z);
        if (below == null || !Perception.isSolidSupport(below)) return;
        if (below2 != null && !Perception.isSolidSupport(below2)) return;
        double dig = cellDigCost(p, player, x, y - 1, z, opts);
        if (dig <= 0) return;
        out.add(new Step(from, new BlockPos(x, y - 1, z), MoveKind.DIG_DOWN,
            List.of(new BlockPos(x, y - 1, z)), List.of(), 10.0 + dig));
    }

    private static boolean columnClear(Perception p, int x, int y, int z) {
        BlockState f = p.getObserved(x, y, z);
        BlockState h = p.getObserved(x, y + 1, z);
        return f != null && h != null && Perception.isPassable(f) && Perception.isPassable(h)
            && f.getFluidState().isEmpty() && h.getFluidState().isEmpty();
    }

    /**
     * Cost to clear a single cell:
     *  - 0.0 if already passable
     *  - -1.0 if forbidden (unbreakable, hazard, adjacent lava/fluid, or unobserved without hypotheses)
     *  - >0.0 estimated break ticks + terrain penalty if diggable
     */
    private double cellDigCost(Perception p, ClientPlayerEntity player, int x, int y, int z, Options opts) {
        BlockState st = p.getObserved(x, y, z);
        if (st == null) {
            if (!opts.allowHypotheses || !opts.allowDigging) return -1.0;
            // Explicit terrain hypothesis: unobserved underground cell assumed diggable rock/soil
            // Allow at or below player's current elevation (+2 headroom) regardless of mountain altitude!
            if (player != null && y > player.getBlockY() + 2) return -1.0;
            return 14.0 + estimatedStoneDigTicks(player) * 0.4;
        }
        if (Perception.isPassable(st) && st.getFluidState().isEmpty()) return 0.0;
        if (!opts.allowDigging) return -1.0;
        if (Perception.isHazardBlock(st) || Perception.isUnbreakable(st) || !st.getFluidState().isEmpty()) return -1.0;
        if (p.isNearKnownLava(x, y, z)) return -1.0;
        // Avoid opening water pockets from the side or above unless already underwater
        if (p.isNearKnownFluidAboveOrSide(x, y, z)) return -1.0;
        // Avoid breaking our own placed workstations
        if (st.isOf(Blocks.CRAFTING_TABLE) || st.isOf(Blocks.FURNACE)) return -1.0;

        // Avoid breaking directly underneath falling blocks (gravel/sand) if possible (high penalty)
        BlockState above = p.getObserved(x, y + 1, z);
        double gravelPenalty = (above != null && above.getBlock() instanceof FallingBlock) ? 20.0 : 0.0;

        if (st.isOf(Blocks.SNOW) || st.isOf(Blocks.SNOW_BLOCK)) return 4.0;
        if (st.getBlock() instanceof LeavesBlock) return 6.0; // cheap to clear blocking tree leaves
        if (st.isIn(BlockTags.DIRT) || st.isOf(Blocks.GRAVEL) || st.isOf(Blocks.SAND) || st.isOf(Blocks.CLAY)) {
            return 9.0 + gravelPenalty;
        }
        if (st.isIn(BlockTags.LOGS)) return 18.0;
        if (st.isOf(Blocks.OBSIDIAN)) return -1.0; // never casually tunnel through obsidian!

        // Hard rock / ore: require a suitable pickaxe (so we don't try punching stone/deepslate by hand)
        double hardness = Math.max(0.2, st.getHardness(null, BlockPos.ORIGIN));
        if (st.isToolRequired() && hardness >= 1.0 && !hasSuitableHotbarTool(player, st)) {
            return -1.0;
        }
        double speed = bestHotbarSpeed(player, st);
        double breakTicks = Math.min(90.0, (hardness * 30.0) / Math.max(1.0, speed));
        return 10.0 + breakTicks * 0.45 + gravelPenalty;
    }

    private static double estimatedStoneDigTicks(ClientPlayerEntity player) {
        if (player == null) return 30.0;
        double speed = bestHotbarSpeed(player, Blocks.STONE.getDefaultState());
        return speed <= 1.0 ? 80.0 : (45.0 / speed);
    }

    private static boolean hasSuitableHotbarTool(ClientPlayerEntity player, BlockState state) {
        if (player == null) return false;
        for (int i = 0; i < 9; i++) {
            if (player.getInventory().getStack(i).isSuitableFor(state)) return true;
        }
        return false;
    }

    private static double bestHotbarSpeed(ClientPlayerEntity player, BlockState state) {
        if (player == null) return 1.0;
        double best = 1.0;
        for (int i = 0; i < 9; i++) {
            var stack = player.getInventory().getStack(i);
            if (!state.isToolRequired() || stack.isSuitableFor(state)) {
                best = Math.max(best, stack.getMiningSpeedMultiplier(state));
            }
        }
        return best;
    }

    private static int sq(int v) { return v * v; }
}
