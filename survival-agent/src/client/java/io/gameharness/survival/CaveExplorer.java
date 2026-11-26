package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.BlockState;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

/**
 * Perception-honest cave mouth, ravine, and underground frontier explorer.
 *
 * Uses ONLY genuinely seen air/rock observations from Perception (never X-rays chunks):
 *  - Identifies surface cave mouths (shaded rock openings) and ravines (deep rocky chasms)
 *  - Tracks visited 4x4x4 sectors so underground exploration flows forward without loops
 *  - Scores unvisited cave frontiers to prioritize descending into genuinely deep caves
 *  - Detects shallow dead-end caves so the player loots visible ores, exits cleanly back to the surface,
 *    and continues scouting for deeper caves or massive ravines
 *  - Transitions smoothly to deep underground mining if a cave reaches prime ore depth and dead-ends
 */
final class CaveExplorer {
    enum Mode {
        SURFACE_SCOUT,
        APPROACHING_ENTRANCE,
        EXPLORING_CAVE,
        EXITING_SHALLOW_CAVE,
        DEEP_BRANCH_MINE;

        String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    enum CaveVerdict {
        CONTINUE_EXPLORING,
        EXIT_SHALLOW_CAVE,
        TRANSITION_DEEP_MINE
    }

    /** A genuinely observed cave opening or ravine lip discovered from optical sight. */
    static final class Entrance {
        final BlockPos pos;
        int minSeenY;
        boolean ravineLike;
        boolean exhausted;
        int discoveredTick;
        int exhaustedTick = -1;
        int seenCount = 1;

        Entrance(BlockPos pos, int minSeenY, boolean ravineLike, int tick) {
            this.pos = pos.toImmutable();
            this.minSeenY = minSeenY;
            this.ravineLike = ravineLike;
            this.discoveredTick = tick;
        }
    }

    /** Pure frontier candidate for unit-testable underground cave navigation scoring. */
    record FrontierCandidate(
        BlockPos pos,
        int skyLight,
        boolean hasSolidFloor,
        boolean nearHazard,
        boolean ravineLike
    ) {}

    private static final int SECTOR_SHIFT = 2; // 4x4x4 coarse visited buckets
    private static final double ENTRANCE_MERGE_HORIZ_SQ = 12.0 * 12.0;
    private static final int MAX_ENTRANCES = 48;
    private static final int MAX_FRONTIER_DIST = 44;

    private final Set<Long> visitedSectors = new HashSet<>();
    private final Set<Long> unreachableFrontiers = new HashSet<>();
    private final List<Entrance> entrances = new ArrayList<>();
    private final Map<Long, Integer> frontierFailCounts = new HashMap<>();

    private Mode mode = Mode.SURFACE_SCOUT;
    private Entrance activeEntrance;
    private BlockPos caveEntryPos;
    private int caveEntryY = 64;
    private int caveDeepestY = 64;
    private int caveEnterTick = -1;
    private int lastNewSectorTick = -1;
    private int lastDeeperTick = -1;
    private int surfaceScoutStartTick = -1;
    private BlockPos activeFrontier;
    private int activeFrontierTicks;
    private int glanceTicks;
    private float glanceBaseYaw;
    private int exhaustedCaveCount;

    void resetForLife() {
        visitedSectors.clear();
        unreachableFrontiers.clear();
        entrances.clear();
        frontierFailCounts.clear();
        mode = Mode.SURFACE_SCOUT;
        activeEntrance = null;
        caveEntryPos = null;
        caveEntryY = 64;
        caveDeepestY = 64;
        caveEnterTick = -1;
        lastNewSectorTick = -1;
        lastDeeperTick = -1;
        surfaceScoutStartTick = -1;
        activeFrontier = null;
        activeFrontierTicks = 0;
        glanceTicks = 0;
        exhaustedCaveCount = 0;
    }

    static long sectorKey(int x, int y, int z) {
        return BlockPos.asLong(x >> SECTOR_SHIFT, y >> SECTOR_SHIFT, z >> SECTOR_SHIFT);
    }

    static long sectorKey(BlockPos pos) {
        return sectorKey(pos.getX(), pos.getY(), pos.getZ());
    }

    Mode mode() { return mode; }
    Entrance activeEntrance() { return activeEntrance; }
    BlockPos caveEntryPos() { return caveEntryPos; }
    BlockPos activeFrontier() { return activeFrontier; }
    int caveDeepestY() { return caveDeepestY; }
    int exhaustedCaveCount() { return exhaustedCaveCount; }
    int glanceTicks() { return glanceTicks; }
    float glanceBaseYaw() { return glanceBaseYaw; }

    void setMode(Mode next, int currentTick) {
        if (this.mode != next) {
            this.mode = next;
            this.activeFrontier = null;
            this.activeFrontierTicks = 0;
            this.glanceTicks = 0;
            if (next == Mode.SURFACE_SCOUT) {
                this.surfaceScoutStartTick = currentTick;
            }
        }
    }

    void beginGlance(float baseYaw, int ticks) {
        this.glanceBaseYaw = baseYaw;
        this.glanceTicks = ticks;
    }

    boolean tickGlance() {
        if (glanceTicks > 0) {
            glanceTicks--;
            return true;
        }
        return false;
    }

    /** Record player movement & update visited sectors + cave depth tracking. */
    void recordPlayerPosition(BlockPos feet, int skyLight, int currentTick) {
        long sk = sectorKey(feet);
        if (visitedSectors.add(sk)) {
            lastNewSectorTick = currentTick;
        }
        // Also mark immediate neighboring vertical sector if standing at a slope
        visitedSectors.add(sectorKey(feet.getX(), feet.getY() + 1, feet.getZ()));

        boolean insideCave = skyLight <= 8 || feet.getY() <= 52;
        if (insideCave) {
            if (caveEnterTick < 0) {
                caveEnterTick = currentTick;
                caveEntryPos = feet.toImmutable();
                caveEntryY = feet.getY();
                caveDeepestY = feet.getY();
                lastDeeperTick = currentTick;
                lastNewSectorTick = currentTick;
            } else if (feet.getY() < caveDeepestY) {
                caveDeepestY = feet.getY();
                lastDeeperTick = currentTick;
            }
        }
    }

    /**
     * Ingest genuinely observed cave/ravine air cells from Perception.
     * Clusters surface cave mouths and ravines without duplicating nearby points.
     */
    void ingestObservations(Collection<Perception.CaveSight> sights, BlockPos playerFeet, int playerSkyLight, int currentTick) {
        if (sights == null || sights.isEmpty()) return;
        boolean playerOnSurface = playerSkyLight >= 12 && playerFeet.getY() >= 54;
        for (Perception.CaveSight s : sights) {
            BlockPos pos = s.pos();
            // Surface cave mouth: shaded opening near surface, OR deep ravine visible from surface
            boolean isSurfaceEntrance = s.ravineLike()
                || (playerOnSurface && s.skyLight() <= 10 && pos.getY() <= playerFeet.getY() + 6 && pos.getY() >= playerFeet.getY() - 28);
            if (!isSurfaceEntrance) continue;
            if (visitedSectors.contains(sectorKey(pos))) continue;
            registerEntrance(pos, s.minFloorY(), s.ravineLike(), currentTick);
        }
    }

    private void registerEntrance(BlockPos pos, int minFloorY, boolean ravineLike, int currentTick) {
        Entrance nearest = null;
        double bestSq = ENTRANCE_MERGE_HORIZ_SQ;
        for (Entrance e : entrances) {
            double dx = e.pos.getX() - pos.getX();
            double dz = e.pos.getZ() - pos.getZ();
            double dSq = dx * dx + dz * dz;
            if (dSq < bestSq && Math.abs(e.pos.getY() - pos.getY()) <= 16) {
                bestSq = dSq;
                nearest = e;
            }
        }
        if (nearest != null) {
            nearest.seenCount++;
            if (minFloorY < nearest.minSeenY) nearest.minSeenY = minFloorY;
            if (ravineLike) nearest.ravineLike = true;
            return;
        }
        if (entrances.size() >= MAX_ENTRANCES) {
            // Evict oldest exhausted entrance first, otherwise farthest entrance
            Entrance evict = null;
            for (Entrance e : entrances) {
                if (e.exhausted && (evict == null || e.exhaustedTick < evict.exhaustedTick)) {
                    evict = e;
                }
            }
            if (evict != null) entrances.remove(evict);
            else entrances.remove(0);
        }
        entrances.add(new Entrance(pos, minFloorY, ravineLike, currentTick));
    }

    /** Pick the most promising unexhausted cave mouth or ravine to investigate from the surface. */
    Entrance pickBestSurfaceEntrance(BlockPos playerFeet) {
        Entrance best = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (Entrance e : entrances) {
            if (e.exhausted) continue;
            double dist = Math.sqrt(e.pos.getSquaredDistance(playerFeet));
            if (dist > 72.0) continue;
            double score = scoreEntrance(playerFeet, e);
            if (score > bestScore) {
                bestScore = score;
                best = e;
            }
        }
        return best;
    }

    static double scoreEntrance(BlockPos playerFeet, Entrance e) {
        double dist = Math.sqrt(e.pos.getSquaredDistance(playerFeet));
        double depthHint = Math.max(0, playerFeet.getY() - e.minSeenY);
        double score = 0.0;
        if (e.ravineLike) score += 26.0;                 // Massive ravines are prime fast-descent goldmines!
        score += Math.min(35.0, depthHint * 2.1);        // Deeper visible openings rank much higher
        score += Math.min(10.0, e.seenCount * 1.4);      // Larger multi-ray openings beat 1-block shadows
        score -= dist * 0.65;                            // Prefer closer entrances when similarly deep
        return score;
    }

    void beginApproachEntrance(Entrance entrance, int currentTick) {
        this.activeEntrance = entrance;
        this.mode = Mode.APPROACHING_ENTRANCE;
        this.activeFrontier = null;
        this.activeFrontierTicks = 0;
        if (surfaceScoutStartTick < 0) surfaceScoutStartTick = currentTick;
    }

    void beginExploringCave(BlockPos entryPos, int currentTick) {
        this.caveEntryPos = entryPos.toImmutable();
        this.caveEntryY = entryPos.getY();
        this.caveDeepestY = entryPos.getY();
        this.caveEnterTick = currentTick;
        this.lastNewSectorTick = currentTick;
        this.lastDeeperTick = currentTick;
        this.mode = Mode.EXPLORING_CAVE;
        this.activeFrontier = null;
        this.activeFrontierTicks = 0;
    }

    void markActiveEntranceExhausted(int currentTick) {
        if (activeEntrance != null && !activeEntrance.exhausted) {
            activeEntrance.exhausted = true;
            activeEntrance.exhaustedTick = currentTick;
            exhaustedCaveCount++;
        } else if (caveEntryPos != null) {
            // Mark any entrance within 18m of where we entered as exhausted too
            boolean markedAny = false;
            for (Entrance e : entrances) {
                if (!e.exhausted && e.pos.getSquaredDistance(caveEntryPos) <= 18.0 * 18.0) {
                    e.exhausted = true;
                    e.exhaustedTick = currentTick;
                    markedAny = true;
                }
            }
            if (!markedAny) {
                Entrance synthetic = new Entrance(caveEntryPos, caveDeepestY, false, currentTick);
                synthetic.exhausted = true;
                synthetic.exhaustedTick = currentTick;
                entrances.add(synthetic);
            }
            exhaustedCaveCount++;
        }
        activeEntrance = null;
    }

    void finishExitToSurface(int currentTick) {
        caveEntryPos = null;
        caveEnterTick = -1;
        activeFrontier = null;
        activeFrontierTicks = 0;
        setMode(Mode.SURFACE_SCOUT, currentTick);
    }

    void markFrontierUnreachable(BlockPos pos) {
        if (pos == null) return;
        long key = pos.asLong();
        int fails = frontierFailCounts.getOrDefault(key, 0) + 1;
        frontierFailCounts.put(key, fails);
        if (fails >= 1) {
            unreachableFrontiers.add(sectorKey(pos));
        }
        if (pos.equals(activeFrontier)) {
            activeFrontier = null;
            activeFrontierTicks = 0;
        }
    }

    boolean isVisitedOrUnreachable(BlockPos pos) {
        long sk = sectorKey(pos);
        return visitedSectors.contains(sk) || unreachableFrontiers.contains(sk);
    }

    void setActiveFrontier(BlockPos frontier) {
        this.activeFrontier = frontier == null ? null : frontier.toImmutable();
        this.activeFrontierTicks = 0;
    }

    int incrementFrontierTicks() {
        return ++activeFrontierTicks;
    }

    /**
     * Build live frontier candidates from genuinely observed cave air cells in Perception,
     * keeping only walkable (or near-floor) unvisited cells free of known lava/hazards.
     */
    BlockPos selectBestCaveFrontier(Perception perception, BlockPos playerFeet, float playerYawDeg, int targetOreY) {
        List<FrontierCandidate> cands = new ArrayList<>();
        for (Perception.CaveSight s : perception.observedCaveSights()) {
            BlockPos pos = s.pos();
            if (isVisitedOrUnreachable(pos)) continue;
            double dSq = pos.getSquaredDistance(playerFeet);
            if (dSq < 3.0 * 3.0 || dSq > MAX_FRONTIER_DIST * MAX_FRONTIER_DIST) continue;
            // Must be cave/underground air or ravine drop (not bright flat surface hills!)
            if (s.skyLight() > 11 && !s.ravineLike() && pos.getY() >= playerFeet.getY() - 3) continue;

            // Snap down 1..3 observed air cells to find a standing floor cell if visible
            BlockPos stand = pos;
            boolean hasFloor = false;
            boolean nearHazard = perception.isNearKnownLava(pos.getX(), pos.getY(), pos.getZ());
            for (int drop = 0; drop <= 4; drop++) {
                BlockPos below = pos.down(drop + 1);
                BlockState bs = perception.getObserved(below);
                if (bs == null) break;
                if (Perception.isHazardBlock(bs)) {
                    nearHazard = true;
                    break;
                }
                if (Perception.isSolidSupport(bs)) {
                    stand = pos.down(drop);
                    hasFloor = true;
                    break;
                }
                if (!Perception.isPassable(bs)) break;
            }
            if (nearHazard) continue;
            if (isVisitedOrUnreachable(stand)) continue;
            cands.add(new FrontierCandidate(stand, s.skyLight(), hasFloor, false, s.ravineLike()));
        }
        return scoreBestFrontier(cands, playerFeet, playerYawDeg, targetOreY);
    }

    /** Pure, unit-testable frontier scorer prioritizing deeper unvisited cave passages! */
    static BlockPos scoreBestFrontier(List<FrontierCandidate> candidates, BlockPos playerFeet,
                                      float playerYawDeg, int targetOreY) {
        if (candidates == null || candidates.isEmpty()) return null;
        double yawRad = Math.toRadians(playerYawDeg + 90.0);
        double hx = Math.cos(yawRad);
        double hz = Math.sin(yawRad);

        BlockPos best = null;
        double bestScore = Double.NEGATIVE_INFINITY;
        for (FrontierCandidate c : candidates) {
            if (c.nearHazard()) continue;
            BlockPos p = c.pos();
            double dx = p.getX() - playerFeet.getX();
            double dy = p.getY() - playerFeet.getY();
            double dz = p.getZ() - playerFeet.getZ();
            double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < 2.5) continue;

            double score = 0.0;
            // Strongly prefer going DEEPER toward targetOreY!
            if (playerFeet.getY() > targetOreY + 4) {
                score += (-dy) * 3.8;
            } else {
                // Already near/at target depth: prefer staying near targetOreY rather than climbing out!
                score -= Math.abs(p.getY() - targetOreY) * 1.6;
            }
            if (c.skyLight() == 0) score += 12.0;          // Genuine dark interior cave passage
            else if (c.skyLight() <= 6) score += 6.0;
            if (c.ravineLike()) score += 10.0;
            if (c.hasSolidFloor()) score += 8.0;           // Known safe solid footing
            if (p.getY() <= targetOreY + 14) score += 14.0;// Already entering prime ore strata!

            // Smooth forward flow along tunnels (avoids ping-ponging)
            double horiz = Math.hypot(dx, dz);
            if (horiz > 0.5) {
                double dot = (dx * hx + dz * hz) / horiz;
                score += dot * 4.5;
            }
            score -= dist * 0.60;

            if (score > bestScore) {
                bestScore = score;
                best = p;
            }
        }
        return best;
    }

    /**
     * Pure, unit-testable verdict deciding whether an explored cave should continue,
     * be left as a shallow dead-end to scout for bigger caves/ravines, or transition
     * to deep underground branch mining because we are already deep underground!
     */
    static CaveVerdict classifyCaveVerdict(int currentY, int deepestY, int targetOreY,
                                           boolean hasUnvisitedFrontier,
                                           int ticksSinceNewSector, int ticksSinceDeeper,
                                           boolean hasVisibleTargetOre) {
        if (hasVisibleTargetOre) return CaveVerdict.CONTINUE_EXPLORING;
        if (hasUnvisitedFrontier && ticksSinceNewSector < 260) {
            return CaveVerdict.CONTINUE_EXPLORING;
        }
        // Still actively descending into deeper passages? Keep going!
        if (hasUnvisitedFrontier && ticksSinceDeeper < 220) {
            return CaveVerdict.CONTINUE_EXPLORING;
        }
        // Frontier exhausted or stalled inside this cave: check whether this cave actually got deep!
        int deepThreshold = targetOreY <= -20 ? -18 : 26;
        if (deepestY <= deepThreshold || currentY <= deepThreshold) {
            return CaveVerdict.TRANSITION_DEEP_MINE;
        }
        return CaveVerdict.EXIT_SHALLOW_CAVE;
    }

    CaveVerdict evaluateCurrentCave(int currentY, int targetOreY, boolean hasUnvisitedFrontier,
                                    boolean hasVisibleTargetOre, int currentTick) {
        int sinceSector = lastNewSectorTick < 0 ? 0 : Math.max(0, currentTick - lastNewSectorTick);
        int sinceDeeper = lastDeeperTick < 0 ? 0 : Math.max(0, currentTick - lastDeeperTick);
        return classifyCaveVerdict(currentY, caveDeepestY, targetOreY, hasUnvisitedFrontier,
            sinceSector, sinceDeeper, hasVisibleTargetOre);
    }

    /** True if surface scouting has gone long enough without spotting any unexhausted cave/ravine to start digging down. */
    boolean surfaceScoutTimedOut(int currentTick, int maxScoutTicks) {
        if (surfaceScoutStartTick < 0) {
            surfaceScoutStartTick = currentTick;
            return false;
        }
        return (currentTick - surfaceScoutStartTick) >= maxScoutTicks;
    }

    int countUnexploredEntrances() {
        int c = 0;
        for (Entrance e : entrances) if (!e.exhausted) c++;
        return c;
    }

    int countUnvisitedFrontiers(Perception perception, BlockPos playerFeet) {
        int c = 0;
        for (Perception.CaveSight s : perception.observedCaveSights()) {
            if (!isVisitedOrUnreachable(s.pos()) && s.pos().getSquaredDistance(playerFeet) <= MAX_FRONTIER_DIST * MAX_FRONTIER_DIST) {
                c++;
            }
        }
        return c;
    }

    int deepestObservedCaveY(Perception perception) {
        int min = caveDeepestY;
        for (Perception.CaveSight s : perception.observedCaveSights()) {
            if (s.minFloorY() < min) min = s.minFloorY();
        }
        return min;
    }
}
