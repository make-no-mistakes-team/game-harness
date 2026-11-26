package io.gameharness.survival;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.CreeperEntity;
import net.minecraft.entity.mob.EndermanEntity;
import net.minecraft.entity.mob.HostileEntity;
import net.minecraft.entity.mob.Monster;
import net.minecraft.entity.mob.SpiderEntity;
import net.minecraft.entity.passive.AnimalEntity;
import net.minecraft.entity.passive.ChickenEntity;
import net.minecraft.entity.passive.CowEntity;
import net.minecraft.entity.passive.PigEntity;
import net.minecraft.entity.passive.RabbitEntity;
import net.minecraft.entity.passive.SheepEntity;
import net.minecraft.fluid.FluidState;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.FluidTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.ChunkPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.RaycastContext;
import net.minecraft.world.chunk.WorldChunk;

/**
 * Non-cheaty player perception & belief map:
 * - Frustum/raycast optical sight (transmitting through leaves/glass via AgentOpticalSight)
 * - Physical contact awareness (immediately adjacent blocks)
 * - Encounter-scoped combat-flow geometry (nearest surfaces within radius 4, stopping at first solid barrier)
 * - Explicit diagnostic-only ore coordinate target reveal (strictly gated behind -Dgh.agent.reveal_ores=true)
 */
final class Perception {
    private static final int MEMORY_LIMIT = 48_000;
    private static final double SIGHT_RANGE = 64.0;
    private static final int COMBAT_FLOW_TICKS = 100;
    private static final int COMBAT_FLOW_RADIUS = 4;

    enum OreKind { COAL, IRON, DIAMOND }

    record ObservedBlock(BlockState state, int tick, boolean combatFlow) {}

    private final MinecraftClient client;
    private final AgentOpticalSight opticalSight;
    private final boolean diagnosticRevealOres;

    // Observed voxel memory (only genuinely seen or touched blocks!)
    private final Map<Long, ObservedBlock> memory = new HashMap<>(8192);
    private final Map<Long, BlockState> combatFlowMemory = new HashMap<>(256);

    // Indexed observed landmarks & resources (maintained from genuine observations only)
    private final Set<BlockPos> observedLogs = new HashSet<>();
    private final Set<BlockPos> observedLeaves = new HashSet<>();
    private final Set<BlockPos> observedStone = new HashSet<>();
    private final Set<BlockPos> observedCoal = new HashSet<>();
    private final Set<BlockPos> observedIron = new HashSet<>();
    private final Set<BlockPos> observedDiamond = new HashSet<>();
    private final Set<BlockPos> observedWater = new HashSet<>();
    private final Set<BlockPos> observedLava = new HashSet<>();
    private final Set<BlockPos> observedBerries = new HashSet<>();
    private final Set<BlockPos> observedTables = new HashSet<>();
    private final Set<BlockPos> observedFurnaces = new HashSet<>();

    // Explicitly gated diagnostic-only ore targets (NEVER used for terrain/caves/lava!)
    private final Set<BlockPos> diagCoal = new HashSet<>();
    private final Set<BlockPos> diagIron = new HashSet<>();
    private final Set<BlockPos> diagDiamond = new HashSet<>();
    private final Set<Long> scannedDiagChunks = new HashSet<>();
    private final Set<Long> retiredDiagOres = new HashSet<>();

    // Live entity observations (visible or recently contacted)
    private final List<LivingEntity> visibleHostiles = new ArrayList<>();
    private final List<AnimalEntity> visibleFoodAnimals = new ArrayList<>();
    private final List<ItemEntity> visibleDrops = new ArrayList<>();

    private int tick;
    private int combatFlowUntilTick = -1;
    private float lastHealth = 20f;
    private int lastHurtTick = -100;
    private int raySweepPhase;

    Perception(MinecraftClient client, boolean diagnosticRevealOres) {
        this.client = client;
        this.opticalSight = new AgentOpticalSight(client);
        this.diagnosticRevealOres = diagnosticRevealOres;
    }

    boolean isDiagnosticRevealOres() { return diagnosticRevealOres; }

    void resetForLife() {
        combatFlowMemory.clear();
        combatFlowUntilTick = -1;
        visibleHostiles.clear();
        visibleFoodAnimals.clear();
        visibleDrops.clear();
        lastHurtTick = -100;
    }

    void tick(int currentTick) {
        this.tick = currentTick;
        var player = client.player;
        var world = client.world;
        if (player == null || world == null) return;

        float hp = player.getHealth();
        if (hp < lastHealth - 0.01f && player.hurtTime > 0) {
            lastHurtTick = currentTick;
            // Damage from a hostile mob triggers combat-flow geometry
            if (player.getAttacker() instanceof Monster || hasNearbyHostileEntity(world, player, 14.0)) {
                combatFlowUntilTick = currentTick + COMBAT_FLOW_TICKS;
            }
        }
        lastHealth = hp;

        // 1. Refresh optical sight asset cache once per tick
        opticalSight.prepare();

        // 2. Observe blocks physically touching/immediately surrounding the player
        observePhysicalNeighborhood(world, player);

        // 3. Cast frustum/optical sight rays from player eye
        castSightFan(world, player);

        // 4. Refresh visible entities (hostiles, food animals, dropped items)
        scanVisibleEntities(world, player);

        // 5. If in active hostile encounter, refresh combat-flow nearest-surface geometry
        combatFlowMemory.clear();
        if (!visibleHostiles.isEmpty()) {
            double nearest = visibleHostiles.get(0).distanceTo(player);
            if (nearest <= 14.0) {
                combatFlowUntilTick = currentTick + COMBAT_FLOW_TICKS;
            }
        }
        if (currentTick <= combatFlowUntilTick) {
            scanCombatFlowGeometry(world, player);
        }

        // 6. Diagnostic-only ore target scan (strictly gated, off by default!)
        if (diagnosticRevealOres && currentTick % 10 == 0) {
            scanDiagnosticOreTargets(world, player);
        }

        // 7. Revalidate a few cached landmarks that are currently within close sight or broken
        if (currentTick % 20 == 0) {
            pruneStaleResources(world, player);
        }
        if (memory.size() > MEMORY_LIMIT) {
            trimOldMemory(player.getBlockPos());
        }
    }

    private void observePhysicalNeighborhood(ClientWorld world, ClientPlayerEntity player) {
        BlockPos feet = player.getBlockPos();
        BlockPos.Mutable m = new BlockPos.Mutable();
        for (int dx = -1; dx <= 1; dx++) {
            for (int dz = -1; dz <= 1; dz++) {
                for (int dy = -1; dy <= 2; dy++) {
                    m.set(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz);
                    recordObserved(m.toImmutable(), world.getBlockState(m), false);
                }
            }
        }
        // Also observe current crosshair hit
        if (client.crosshairTarget instanceof BlockHitResult bhr && bhr.getType() == HitResult.Type.BLOCK) {
            BlockPos bp = bhr.getBlockPos();
            recordObserved(bp, world.getBlockState(bp), false);
            BlockPos adj = bp.offset(bhr.getSide());
            recordObserved(adj, world.getBlockState(adj), false);
        }
    }

    private void castSightFan(ClientWorld world, ClientPlayerEntity player) {
        Vec3d eye = player.getEyePos();
        float yaw = player.getYaw();
        float pitch = player.getPitch();

        // Interleave slightly across 4 phases so full FOV is densely observed within 0.2s
        raySweepPhase = (raySweepPhase + 1) & 3;
        float yawJitter = (raySweepPhase - 1.5f) * 2.2f;
        float pitchJitter = ((raySweepPhase & 1) == 0 ? -1.4f : 1.4f);

        // 11 yaw columns x 7 pitch rows = 77 rays per tick within 100deg x 72deg FOV
        for (int yi = -5; yi <= 5; yi++) {
            float ry = yaw + yi * 9.5f + yawJitter;
            for (int pi = -3; pi <= 3; pi++) {
                float rp = MathHelper.clamp(pitch + pi * 10.5f + pitchJitter, -88f, 88f);
                castSingleSightRay(world, player, eye, ry, rp, SIGHT_RANGE);
            }
        }
        // Plus 12 close-range ground/step rays in front of feet so walking path stays crisp
        for (int yi = -2; yi <= 2; yi++) {
            castSingleSightRay(world, player, eye, yaw + yi * 14f, MathHelper.clamp(pitch + 28f, -60f, 82f), 10.0);
        }
    }

    private void castSingleSightRay(ClientWorld world, ClientPlayerEntity player, Vec3d eye, float yawDeg, float pitchDeg, double range) {
        Vec3d dir = Vec3d.fromPolar(pitchDeg, yawDeg);
        Vec3d end = eye.add(dir.multiply(range));

        // 1. Standard outline+fluid raycast to see solid surfaces, leaves, water, lava
        BlockHitResult solidHit = world.raycast(new RaycastContext(
            eye, end, RaycastContext.ShapeType.OUTLINE, RaycastContext.FluidHandling.ANY, player));
        if (solidHit.getType() == HitResult.Type.BLOCK) {
            BlockPos hitPos = solidHit.getBlockPos();
            BlockState hitState = world.getBlockState(hitPos);
            recordObserved(hitPos, hitState, false);
            // Air/space immediately in front of the hit face is also clearly seen along the ray
            BlockPos front = hitPos.offset(solidHit.getSide());
            recordObserved(front, world.getBlockState(front), false);

            // Sample a few empty cells along the visible ray segment (up to 8m) so air corridors are known to A*
            double dist = eye.distanceTo(solidHit.getPos());
            int samples = Math.min(7, (int) dist);
            for (int s = 1; s < samples; s++) {
                Vec3d p = eye.add(dir.multiply(s));
                BlockPos bp = BlockPos.ofFloored(p);
                if (!bp.equals(hitPos)) {
                    BlockState bs = world.getBlockState(bp);
                    if (bs.isAir() || bs.isReplaceable()) {
                        recordObserved(bp, bs, false);
                    }
                }
            }

            // 2. If hit was leaves/glass/water, also cast an optical-sight ray through it!
            if (hitState.isIn(BlockTags.LEAVES) || hitState.isOf(Blocks.GLASS) || !hitState.getFluidState().isEmpty()) {
                BlockHitResult optHit = opticalSight.raycast(world, eye, end, net.minecraft.block.ShapeContext.of(player));
                if (optHit.getType() == HitResult.Type.BLOCK && !optHit.getBlockPos().equals(hitPos)) {
                    BlockPos op = optHit.getBlockPos();
                    recordObserved(op, world.getBlockState(op), false);
                }
            }
        } else {
            // Open air ray — record nearby air cells along it
            for (int s = 1; s <= 6; s++) {
                BlockPos bp = BlockPos.ofFloored(eye.add(dir.multiply(s)));
                BlockState bs = world.getBlockState(bp);
                if (bs.isAir() || bs.isReplaceable()) {
                    recordObserved(bp, bs, false);
                }
            }
        }
    }

    /**
     * Encounter-scoped combat-flow geometry:
     * Casts short rays in all directions up to radius 4 (including behind the player),
     * stopping at the FIRST solid obstacle so hidden rooms/ores stay completely unknown.
     */
    private void scanCombatFlowGeometry(ClientWorld world, ClientPlayerEntity player) {
        Vec3d eye = player.getEyePos();
        for (int yi = 0; yi < 16; yi++) {
            float ry = yi * 22.5f;
            for (int pi = -2; pi <= 3; pi++) {
                float rp = pi * 20f;
                Vec3d dir = Vec3d.fromPolar(rp, ry);
                Vec3d end = eye.add(dir.multiply(COMBAT_FLOW_RADIUS + 0.5));
                BlockHitResult hit = world.raycast(new RaycastContext(
                    eye, end, RaycastContext.ShapeType.COLLIDER, RaycastContext.FluidHandling.ANY, player));
                double maxD = hit.getType() == HitResult.Type.BLOCK ? eye.distanceTo(hit.getPos()) : COMBAT_FLOW_RADIUS;
                for (double d = 0.8; d < maxD; d += 0.9) {
                    BlockPos bp = BlockPos.ofFloored(eye.add(dir.multiply(d)));
                    combatFlowMemory.put(bp.asLong(), world.getBlockState(bp));
                }
                if (hit.getType() == HitResult.Type.BLOCK) {
                    BlockPos hp = hit.getBlockPos();
                    combatFlowMemory.put(hp.asLong(), world.getBlockState(hp));
                }
            }
        }
    }

    private void scanVisibleEntities(ClientWorld world, ClientPlayerEntity player) {
        visibleHostiles.clear();
        visibleFoodAnimals.clear();
        visibleDrops.clear();

        Vec3d eye = player.getEyePos();
        Vec3d look = player.getRotationVec(1.0f);
        boolean flowActive = tick <= combatFlowUntilTick;

        for (Entity entity : world.getEntities()) {
            if (entity == player || !entity.isAlive()) continue;
            double distSq = entity.squaredDistanceTo(player);
            if (distSq > 28.0 * 28.0) continue;

            if (entity instanceof ItemEntity item && distSq <= 18.0 * 18.0) {
                if (distSq <= 25.0 || canSeeEntity(world, player, eye, look, entity, false)) {
                    visibleDrops.add(item);
                }
            } else if (isHostileThreat(entity)) {
                LivingEntity mob = (LivingEntity) entity;
                boolean withinFlow = flowActive && distSq <= 6.0 * 6.0;
                if (withinFlow || canSeeEntity(world, player, eye, look, mob, distSq <= 25.0)) {
                    visibleHostiles.add(mob);
                }
            } else if (isFoodAnimal(entity)) {
                AnimalEntity animal = (AnimalEntity) entity;
                if (!animal.isBaby() && canSeeEntity(world, player, eye, look, animal, false)) {
                    visibleFoodAnimals.add(animal);
                }
            }
        }

        visibleHostiles.sort(Comparator.comparingDouble(e -> e.squaredDistanceTo(player)));
        visibleFoodAnimals.sort(Comparator.comparingDouble(e -> e.squaredDistanceTo(player)));
        visibleDrops.sort(Comparator.comparingDouble(e -> e.squaredDistanceTo(player)));
    }

    private boolean canSeeEntity(ClientWorld world, ClientPlayerEntity player, Vec3d eye, Vec3d look, Entity entity, boolean allowPeripheral) {
        Vec3d center = entity.getBoundingBox().getCenter();
        Vec3d to = center.subtract(eye);
        double dist = to.length();
        if (dist < 1e-4) return true;
        double dot = look.dotProduct(to.multiply(1.0 / dist));
        if (!allowPeripheral && dot < 0.15) return false;
        BlockHitResult hit = world.raycast(new RaycastContext(
            eye, center, RaycastContext.ShapeType.COLLIDER, RaycastContext.FluidHandling.NONE, player));
        return hit.getType() == HitResult.Type.MISS || eye.squaredDistanceTo(hit.getPos()) >= dist * dist - 0.8;
    }

    private static boolean hasNearbyHostileEntity(ClientWorld world, ClientPlayerEntity player, double radius) {
        double rSq = radius * radius;
        for (Entity e : world.getEntities()) {
            if (e != player && e.isAlive() && isHostileThreat(e) && e.squaredDistanceTo(player) <= rSq) {
                return true;
            }
        }
        return false;
    }

    static boolean isHostileThreat(Entity e) {
        if (!(e instanceof LivingEntity)) return false;
        if (e instanceof EndermanEntity enderman) return enderman.isAngry();
        if (e instanceof SpiderEntity spider) {
            return spider.getTarget() != null || spider.isAttacking() || spider.getBrightnessAtEyes() < 0.5f;
        }
        return e instanceof HostileEntity || e instanceof CreeperEntity || e instanceof Monster;
    }

    static boolean isFoodAnimal(Entity e) {
        return e instanceof PigEntity || e instanceof CowEntity || e instanceof SheepEntity
            || e instanceof ChickenEntity || e instanceof RabbitEntity;
    }

    /** Record an observed block and index notable resources/landmarks. */
    void recordObserved(BlockPos pos, BlockState state, boolean combatFlow) {
        BlockPos imm = pos.toImmutable();
        memory.put(imm.asLong(), new ObservedBlock(state, tick, combatFlow));

        // Update resource indices
        Block b = state.getBlock();
        boolean isLog = state.isIn(BlockTags.LOGS);
        updateIndex(observedLogs, imm, isLog);
        updateIndex(observedLeaves, imm, state.isIn(BlockTags.LEAVES));
        updateIndex(observedStone, imm, b == Blocks.STONE || b == Blocks.COBBLESTONE || b == Blocks.DEEPSLATE);
        updateIndex(observedCoal, imm, b == Blocks.COAL_ORE || b == Blocks.DEEPSLATE_COAL_ORE);
        updateIndex(observedIron, imm, b == Blocks.IRON_ORE || b == Blocks.DEEPSLATE_IRON_ORE);
        updateIndex(observedDiamond, imm, b == Blocks.DIAMOND_ORE || b == Blocks.DEEPSLATE_DIAMOND_ORE);
        updateIndex(observedWater, imm, state.getFluidState().isIn(FluidTags.WATER));
        updateIndex(observedLava, imm, state.getFluidState().isIn(FluidTags.LAVA));
        updateIndex(observedTables, imm, b == Blocks.CRAFTING_TABLE);
        updateIndex(observedFurnaces, imm, b == Blocks.FURNACE);
        boolean ripeBerry = b == Blocks.SWEET_BERRY_BUSH && state.contains(SweetBerryBushBlock.AGE)
            && state.get(SweetBerryBushBlock.AGE) >= 2;
        updateIndex(observedBerries, imm, ripeBerry);

        // If a diagnostic ore cell was observed and is no longer that ore, retire it!
        if (diagnosticRevealOres) {
            long key = imm.asLong();
            if (diagCoal.contains(imm) && !(b == Blocks.COAL_ORE || b == Blocks.DEEPSLATE_COAL_ORE)) {
                diagCoal.remove(imm);
                retiredDiagOres.add(key);
            }
            if (diagIron.contains(imm) && !(b == Blocks.IRON_ORE || b == Blocks.DEEPSLATE_IRON_ORE)) {
                diagIron.remove(imm);
                retiredDiagOres.add(key);
            }
            if (diagDiamond.contains(imm) && !(b == Blocks.DIAMOND_ORE || b == Blocks.DEEPSLATE_DIAMOND_ORE)) {
                diagDiamond.remove(imm);
                retiredDiagOres.add(key);
            }
        }
    }

    private static void updateIndex(Set<BlockPos> set, BlockPos pos, boolean present) {
        if (present) set.add(pos);
        else set.remove(pos);
    }

    /**
     * Explicitly gated diagnostic-only ore coordinate scan.
     * Scans loaded chunks within 4 chunks of the player for coal, iron, and diamond ore coordinates ONLY.
     * Does NOT reveal intervening terrain, caves, water, or lava!
     */
    private void scanDiagnosticOreTargets(ClientWorld world, ClientPlayerEntity player) {
        ChunkPos center = player.getChunkPos();
        int chunksThisTick = 0;
        for (int cx = center.x - 4; cx <= center.x + 4 && chunksThisTick < 4; cx++) {
            for (int cz = center.z - 4; cz <= center.z + 4 && chunksThisTick < 4; cz++) {
                long cKey = ChunkPos.toLong(cx, cz);
                if (scannedDiagChunks.contains(cKey)) continue;
                WorldChunk chunk = world.getChunkManager().getWorldChunk(cx, cz);
                if (chunk == null) continue;
                scannedDiagChunks.add(cKey);
                chunksThisTick++;

                int baseX = cx << 4;
                int baseZ = cz << 4;
                int minY = world.getBottomY();
                int maxY = Math.min(128, world.getTopYInclusive());
                BlockPos.Mutable m = new BlockPos.Mutable();
                for (int y = minY; y <= maxY; y++) {
                    for (int lx = 0; lx < 16; lx++) {
                        for (int lz = 0; lz < 16; lz++) {
                            m.set(baseX + lx, y, baseZ + lz);
                            BlockState st = chunk.getBlockState(m);
                            Block b = st.getBlock();
                            if (b == Blocks.DIAMOND_ORE || b == Blocks.DEEPSLATE_DIAMOND_ORE) {
                                if (!retiredDiagOres.contains(m.asLong())) diagDiamond.add(m.toImmutable());
                            } else if (b == Blocks.IRON_ORE || b == Blocks.DEEPSLATE_IRON_ORE) {
                                if (!retiredDiagOres.contains(m.asLong())) diagIron.add(m.toImmutable());
                            } else if (b == Blocks.COAL_ORE || b == Blocks.DEEPSLATE_COAL_ORE) {
                                if (!retiredDiagOres.contains(m.asLong())) diagCoal.add(m.toImmutable());
                            }
                        }
                    }
                }
            }
        }
    }

    void markOreRetired(BlockPos pos) {
        if (pos == null) return;
        retiredDiagOres.add(pos.asLong());
        diagCoal.remove(pos);
        diagIron.remove(pos);
        diagDiamond.remove(pos);
        observedCoal.remove(pos);
        observedIron.remove(pos);
        observedDiamond.remove(pos);
    }

    private void pruneStaleResources(ClientWorld world, ClientPlayerEntity player) {
        BlockPos p = player.getBlockPos();
        // Prune far-away observed entries so queries stay fast
        observedLogs.removeIf(pos -> pos.getSquaredDistance(p) > 72 * 72);
        observedLeaves.removeIf(pos -> pos.getSquaredDistance(p) > 72 * 72);
        observedStone.removeIf(pos -> pos.getSquaredDistance(p) > 48 * 48);
        observedWater.removeIf(pos -> pos.getSquaredDistance(p) > 64 * 64);
        observedLava.removeIf(pos -> pos.getSquaredDistance(p) > 64 * 64);
        observedBerries.removeIf(pos -> pos.getSquaredDistance(p) > 64 * 64);
    }

    private void trimOldMemory(BlockPos playerPos) {
        int cutoff = tick - 600;
        memory.entrySet().removeIf(e -> {
            if (e.getValue().tick() >= cutoff) return false;
            BlockPos bp = BlockPos.fromLong(e.getKey());
            return bp.getSquaredDistance(playerPos) > 40 * 40;
        });
    }

    /** Query observed block state (combat-flow geometry + observed voxel memory). Returns null if unobserved. */
    BlockState getObserved(int x, int y, int z) {
        long key = BlockPos.asLong(x, y, z);
        BlockState cf = combatFlowMemory.get(key);
        if (cf != null) return cf;
        ObservedBlock ob = memory.get(key);
        return ob == null ? null : ob.state();
    }

    BlockState getObserved(BlockPos pos) {
        return getObserved(pos.getX(), pos.getY(), pos.getZ());
    }

    boolean isCombatFlowActive() { return tick <= combatFlowUntilTick; }
    int lastHurtTick() { return lastHurtTick; }

    List<LivingEntity> visibleHostiles() { return visibleHostiles; }
    List<AnimalEntity> visibleFoodAnimals() { return visibleFoodAnimals; }
    List<ItemEntity> visibleDrops() { return visibleDrops; }

    Set<BlockPos> observedLogs() { return observedLogs; }
    Set<BlockPos> observedLeaves() { return observedLeaves; }
    Set<BlockPos> observedStone() { return observedStone; }
    Set<BlockPos> observedCoal() { return observedCoal; }
    Set<BlockPos> observedIron() { return observedIron; }
    Set<BlockPos> observedDiamond() { return observedDiamond; }
    Set<BlockPos> observedWater() { return observedWater; }
    Set<BlockPos> observedLava() { return observedLava; }
    Set<BlockPos> observedBerries() { return observedBerries; }
    Set<BlockPos> observedTables() { return observedTables; }
    Set<BlockPos> observedFurnaces() { return observedFurnaces; }

    /** Returns nearest observed ore of `kind`, or if diagnostic ore reveal is active, nearest diagnostic ore! */
    List<BlockPos> nearestOreTargets(OreKind kind, BlockPos from, int limit, Set<BlockPos> skip) {
        Set<BlockPos> observed = switch (kind) {
            case COAL -> observedCoal;
            case IRON -> observedIron;
            case DIAMOND -> observedDiamond;
        };
        List<BlockPos> candidates = new ArrayList<>();
        for (BlockPos pos : observed) {
            if (skip == null || !skip.contains(pos)) candidates.add(pos);
        }
        if (diagnosticRevealOres) {
            Set<BlockPos> diag = switch (kind) {
                case COAL -> diagCoal;
                case IRON -> diagIron;
                case DIAMOND -> diagDiamond;
            };
            for (BlockPos pos : diag) {
                if ((skip == null || !skip.contains(pos)) && !observed.contains(pos)) {
                    candidates.add(pos);
                }
            }
        }
        // Score prefers targets closer horizontally and not way above the player
        candidates.sort(Comparator.comparingDouble(pos -> oreScore(from, pos, observed.contains(pos))));
        return candidates.size() <= limit ? candidates : candidates.subList(0, limit);
    }

    private static double oreScore(BlockPos from, BlockPos pos, boolean alreadySeen) {
        double horiz = Math.hypot(pos.getX() - from.getX(), pos.getZ() - from.getZ());
        int dy = pos.getY() - from.getY();
        double vert = dy < 0 ? (-dy) * 1.6 : dy * 2.4;
        return horiz + vert - (alreadySeen ? 12.0 : 0.0);
    }

    BlockPos nearestObserved(Set<BlockPos> set, BlockPos from, double maxDist, Set<BlockPos> skip) {
        BlockPos best = null;
        double bestScore = Double.POSITIVE_INFINITY;
        double maxSq = maxDist * maxDist;
        for (BlockPos pos : set) {
            if (skip != null && skip.contains(pos)) continue;
            double dSq = pos.getSquaredDistance(from);
            if (dSq > maxSq) continue;
            // Slightly prefer reachable/same-height blocks over high canopy blocks
            double score = Math.sqrt(dSq) + Math.abs(pos.getY() - from.getY()) * 0.8;
            if (score < bestScore) {
                bestScore = score;
                best = pos;
            }
        }
        return best;
    }

    boolean isNearKnownLava(int x, int y, int z) {
        for (Direction d : Direction.values()) {
            BlockState st = getObserved(x + d.getOffsetX(), y + d.getOffsetY(), z + d.getOffsetZ());
            if (st != null && st.getFluidState().isIn(FluidTags.LAVA)) return true;
        }
        return false;
    }

    boolean isNearKnownFluidAboveOrSide(int x, int y, int z) {
        BlockState above = getObserved(x, y + 1, z);
        if (above != null && !above.getFluidState().isEmpty()) return true;
        for (Direction d : Direction.Type.HORIZONTAL) {
            BlockState side = getObserved(x + d.getOffsetX(), y, z + d.getOffsetZ());
            if (side != null && !side.getFluidState().isEmpty()) return true;
        }
        return false;
    }

    static boolean isHazardBlock(BlockState st) {
        if (st == null) return false;
        FluidState fs = st.getFluidState();
        if (fs.isIn(FluidTags.LAVA)) return true;
        Block b = st.getBlock();
        return b == Blocks.FIRE || b == Blocks.SOUL_FIRE || b == Blocks.MAGMA_BLOCK
            || b == Blocks.CACTUS || b == Blocks.CAMPFIRE || b == Blocks.SOUL_CAMPFIRE
            || b == Blocks.SWEET_BERRY_BUSH || b == Blocks.POWDER_SNOW || b == Blocks.WITHER_ROSE;
    }

    static boolean isSolidSupport(BlockState st) {
        if (st == null || st.isAir() || !st.getFluidState().isEmpty()) return false;
        if (isHazardBlock(st)) return false;
        Block b = st.getBlock();
        if (b == Blocks.COBWEB || b == Blocks.BIG_DRIPLEAF || b == Blocks.SCAFFOLDING) return false;
        return st.blocksMovement();
    }

    static boolean isPassable(BlockState st) {
        if (st == null) return false;
        if (isHazardBlock(st)) return false;
        if (!st.getFluidState().isEmpty()) return st.getFluidState().isIn(FluidTags.WATER);
        if (st.isOf(Blocks.SNOW) && st.contains(net.minecraft.block.SnowBlock.LAYERS)
                && st.get(net.minecraft.block.SnowBlock.LAYERS) <= 2) return true;
        return st.isAir() || !st.blocksMovement();
    }

    static boolean isUnbreakable(BlockState st) {
        if (st == null) return false;
        Block b = st.getBlock();
        return b == Blocks.BEDROCK || b == Blocks.BARRIER || b == Blocks.END_PORTAL_FRAME
            || b == Blocks.END_PORTAL || b == Blocks.NETHER_PORTAL || b == Blocks.WATER || b == Blocks.LAVA;
    }
}
