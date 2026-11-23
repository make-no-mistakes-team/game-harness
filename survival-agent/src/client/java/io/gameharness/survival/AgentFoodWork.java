package io.gameharness.survival;

import java.util.Map;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.LivingEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.BlockTags;
import net.minecraft.registry.tag.ItemTags;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;

/** Local meal policy, with exact-work sources narrower than ordinary forage. */
final class AgentFoodWork {
    static final String EFFECT = "forage:";
    static final int MAX_SWINGS = 4;
    static final int MAX_TICKS = 110;
    static final int DROP_TICKS = 22;
    static final double LEASH = 4;

    enum Source {
        SWEET_BERRIES("block", "sweet_berry_bush", Items.SWEET_BERRIES),
        GLOW_VINES("block", "cave_vines", Items.GLOW_BERRIES),
        GLOW_PLANT("block", "cave_vines_plant", Items.GLOW_BERRIES),
        COW("entity", "cow", Items.BEEF, Items.COOKED_BEEF),
        MOOSHROOM("entity", "mooshroom", Items.BEEF, Items.COOKED_BEEF),
        PIG("entity", "pig", Items.PORKCHOP, Items.COOKED_PORKCHOP),
        SHEEP("entity", "sheep", Items.MUTTON, Items.COOKED_MUTTON),
        RABBIT("entity", "rabbit", Items.RABBIT, Items.COOKED_RABBIT),
        CHICKEN("entity", "chicken", Items.CHICKEN, Items.COOKED_CHICKEN);

        final String subject, effect;
        final Item item, cooked;
        final ItemStack stock;

        Source(String kind, String name, Item item) {
            this(kind, name, item, null);
        }

        Source(String kind, String name, Item item, Item cooked) {
            subject = kind + ":minecraft:" + name;
            effect = EFFECT + subject;
            this.item = item;
            this.cooked = cooked;
            stock = new ItemStack(item);
        }

        boolean animal() { return ordinal() >= COW.ordinal(); }
        boolean matchesDrop(ItemStack stack) { return stack.isOf(item) || cooked != null && stack.isOf(cooked); }
    }

    private static final Source[] SOURCES = Source.values();

    static Source effect(String effect) {
        for (Source source : SOURCES) if (source != Source.CHICKEN && source.effect.equals(effect)) return source;
        return null;
    }

    static Source ripe(BlockState state) {
        if (state.isOf(Blocks.SWEET_BERRY_BUSH) && state.get(SweetBerryBushBlock.AGE) >= 2) return Source.SWEET_BERRIES;
        if (state.isOf(Blocks.CAVE_VINES) && state.get(CaveVines.BERRIES)) return Source.GLOW_VINES;
        if (state.isOf(Blocks.CAVE_VINES_PLANT) && state.get(CaveVines.BERRIES)) return Source.GLOW_PLANT;
        return null;
    }

    static Source adult(Entity entity) {
        return adult(entity, false);
    }

    static Source ordinaryAdult(Entity entity) {
        return adult(entity, true);
    }

    private static Source adult(Entity entity, boolean ordinary) {
        if (!(entity instanceof LivingEntity animal) || !animal.isAlive() || animal.isBaby() || animal.isTouchingWater()) return null;
        EntityType<?> type = entity.getType();
        if (type == EntityType.COW) return Source.COW;
        if (type == EntityType.MOOSHROOM) return Source.MOOSHROOM;
        if (type == EntityType.PIG) return Source.PIG;
        if (type == EntityType.SHEEP) return Source.SHEEP;
        if (type == EntityType.RABBIT) return Source.RABBIT;
        if (ordinary && type == EntityType.CHICKEN) return Source.CHICKEN;
        return null;
    }

    /** No source, denied input, and safety interruptions do not end a recovery. */
    static final class HealingGoal {
        private boolean active;

        boolean update(int hunger, float health, float maxHealth) {
            boolean recovered = health >= maxHealth * 0.7f;
            if (active) {
                if (hunger >= 18 && recovered) active = false;
            } else if (hunger <= 10 || health <= maxHealth * 0.5f || !recovered && hunger < 18) {
                active = true;
            }
            return active;
        }

        boolean active() { return active; }
        boolean canRest(int hunger) { return active && hunger >= 18; }
        void reset() { active = false; }
    }

    /** One view request per recovery, with no target, movement, or contact authority. */
    static final class PoultryLook {
        static final float PITCH = 20;
        private static final int LOOK_TICKS = 24;
        enum View { LOOKING, FINISHED, SCOUT_HANDOFF }

        private BlockPos foot;
        private long fromFrame;
        private int lastTick, until;
        private float bearing;
        private boolean spent, scoutHandoff;

        boolean available() { return !spent; }
        boolean active() { return foot != null; }
        float bearing() { return bearing; }

        boolean begin(float yaw, BlockPos stoppedFoot, int tick, long frame, boolean handoff) {
            if (spent || stoppedFoot == null || !Float.isFinite(yaw)) return false;
            spent = true;
            scoutHandoff = handoff;
            foot = stoppedFoot;
            bearing = yaw;
            lastTick = tick;
            until = tick + LOOK_TICKS;
            fromFrame = frame;
            return true;
        }

        View awaitView(BlockPos stoppedFoot, int tick, long frame, boolean aligned) {
            boolean continuous = foot != null && foot.equals(stoppedFoot) && tick == lastTick + 1;
            if (!continuous || tick >= until || frame > fromFrame && aligned) {
                finish();
                return continuous && scoutHandoff ? View.SCOUT_HANDOFF : View.FINISHED;
            }
            lastTick = tick;
            return View.LOOKING;
        }

        void finish() { foot = null; }
        void reset() { finish(); spent = false; }
    }

    enum SourceAction { APPROACH, CONTACT, REFUSE }

    /** Call only with a currently witnessed source. Range alone never authorizes contact. */
    static SourceAction sourceAction(boolean dry, boolean inReach, boolean directed) {
        if (!dry) return SourceAction.REFUSE;
        if (inReach) return SourceAction.CONTACT;
        return directed ? SourceAction.APPROACH : SourceAction.REFUSE;
    }

    static SourceAction huntAction(double eyeDistanceSquared, double reach, boolean dry, boolean directed) {
        return sourceAction(dry, criticalHuntContact(eyeDistanceSquared, reach, dry), directed);
    }

    static SourceAction dropAction(Box player, Box drop, boolean grounded, boolean dry, boolean directed) {
        if (!dry) return SourceAction.REFUSE;
        if (AgentPickup.passiveOverlap(player, drop)) return SourceAction.CONTACT;
        if (!grounded) return SourceAction.REFUSE;
        if (directed) return SourceAction.APPROACH;
        if (!pickupHeight(player, drop)) return SourceAction.REFUSE;
        double dx = (drop.minX + drop.maxX - player.minX - player.maxX) * 0.5;
        double dz = (drop.minZ + drop.maxZ - player.minZ - player.maxZ) * 0.5;
        return dx * dx + dz * dz <= 1.6 * 1.6 ? SourceAction.CONTACT : SourceAction.REFUSE;
    }

    private static boolean pickupHeight(Box player, Box drop) {
        return drop.maxY > player.minY - 0.5 && drop.minY < player.maxY + 0.5;
    }

    static AgentResourceStance dropStance(Box drop, double height) {
        return new AgentResourceStance(drop.getCenter(), 0.65, drop.minY - height - 0.49, drop.maxY + 0.49);
    }

    static boolean appleLeaf(BlockState state) {
        return (state.isOf(Blocks.OAK_LEAVES) || state.isOf(Blocks.DARK_OAK_LEAVES)) && state.getFluidState().isEmpty();
    }

    static boolean forageGround(BlockState state) {
        return (state.isIn(BlockTags.DIRT) || state.isOf(Blocks.MOSS_BLOCK)) && !AgentBody.dryCaveDanger(state);
    }

    /** A lower top seen in the frustum supplies a bearing, not permission to descend to it. */
    static Direction lowerForageBearing(BlockPos from, BlockPos floor) {
        if (floor.getY() >= from.getY() - 1) return null;
        int dx = floor.getX() - from.getX(), dz = floor.getZ() - from.getZ();
        if (dx == 0 && dz == 0) return null;
        return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? Direction.EAST : Direction.WEST)
            : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
    }

    static AgentSurfaceTread.Edge canopyEdge(BlockPos from, BlockState source, Direction bearing,
                                             BlockPos to, BlockState witnessedTop) {
        if (source == null || !AgentSupplyEgress.naturalDryLeaf(source) || witnessedTop == null
                || !AgentDryLanding.shape(from, to, bearing)
                || !(forageGround(witnessedTop) || AgentSupplyEgress.naturalDryLeaf(witnessedTop))) return null;
        return new AgentSurfaceTread.Edge(from, source, to, witnessedTop, bearing);
    }

    static boolean canopyDropAllowed(int drop, double safeFallDistance, double fallDistance) {
        return drop >= 1 && drop <= AgentDryLanding.MAX_DROP
            && safeFallDistance >= drop + 0.35 && fallDistance <= 0.05;
    }

    static boolean canopyMask(BlockPos foot, Box player, Direction bearing, BlockHitResult hit,
                              BlockState leaves, boolean protectedSupport) {
        if (hit == null || protectedSupport) return false;
        BlockPos at = hit.getBlockPos();
        int x = at.getX(), y = at.getY(), z = at.getZ();
        return !player.intersects(x - 0.1, y - 0.1, z - 0.1, x + 1.1, y + 1.1, z + 1.1)
            && (AgentSupplyEgress.canopyTopLeaf(foot, bearing, hit, leaves, false)
                || AgentSupplyEgress.canopyLeaf(foot, bearing, hit, leaves, false));
    }

    static boolean leafClearOfStance(BlockPos foot, Box player, BlockPos leaf) {
        int x = leaf.getX(), y = leaf.getY(), z = leaf.getZ();
        // A stationary stand still leaves a little room for braking/knockback.
        return y >= foot.getY() && !player.intersects(x - 0.1, y, z - 0.1, x + 1.1, y + 1, z + 1.1);
    }

    /** A candidate catch, not a prediction of an apple or its random bounce. */
    static boolean appleCatch(Box player, int x, int landingY, int z) {
        return landingY + 0.25 > player.minY - 0.5 && landingY < player.maxY + 0.5
            && x + 0.25 > player.minX - 1 && x + 0.75 < player.maxX + 1
            && z + 0.25 > player.minZ - 1 && z + 0.75 < player.maxZ + 1;
    }

    static final class AppleStand {
        static final int MAX_FACES = 6, STAND_TICKS = 145, RETRY_TICKS = 200, FACE_TICKS = 28;
        private final long[] faces = new long[MAX_FACES];
        private BlockPos foot;
        private int start, targetSince, attempted;

        void reset() { foot = null; }

        boolean canStart(BlockPos at, int tick) {
            return foot == null || foot.getSquaredDistance(at) > 16 || tick - start >= RETRY_TICKS;
        }

        void start(BlockPos at, int tick) {
            foot = at;
            start = tick;
            attempted = 0;
        }

        boolean active(BlockPos at, int tick) {
            return at.equals(foot) && tick - start < STAND_TICKS;
        }

        boolean canTry(BlockPos leaf, int tick) {
            if (foot == null || tick - start >= STAND_TICKS || attempted == MAX_FACES) return false;
            long pos = leaf.asLong();
            for (int i = 0; i < attempted; i++) if (faces[i] == pos) return false;
            return true;
        }

        void tryFace(BlockPos leaf, int tick) {
            faces[attempted++] = leaf.asLong();
            targetSince = tick;
        }

        boolean faceExpired(int tick) { return tick - targetSince >= FACE_TICKS; }

        int attempted() { return attempted; }
    }

    static boolean mealConfirmed(int beforeHunger, int hunger, int beforeCount, int count) {
        return hunger > beforeHunger && count < beforeCount;
    }

    static boolean safeMeal(ItemStack stack) {
        return positiveNutrition(stack) && !stack.isOf(Items.ROTTEN_FLESH) && !stack.isOf(Items.SPIDER_EYE)
            && !stack.isOf(Items.POISONOUS_POTATO) && !stack.isOf(Items.PUFFERFISH)
            && !stack.isOf(Items.CHICKEN) && !stack.isOf(Items.SUSPICIOUS_STEW) && !stack.isOf(Items.CHORUS_FRUIT);
    }

    static boolean fleshMeal(ItemStack stack) {
        return stack.isOf(Items.ROTTEN_FLESH) && positiveNutrition(stack);
    }

    static boolean poultryMeal(ItemStack stack) {
        return stack.isOf(Items.CHICKEN) && positiveNutrition(stack);
    }

    // Ordered weakest first. Safe food always wins the usual nutrition ranking.
    enum Meal { NONE, FLESH, POULTRY, SAFE }

    static Meal mealPriority(ItemStack stack, boolean emergency, boolean ordinaryRecovery) {
        if (safeMeal(stack)) return Meal.SAFE;
        if (!emergency) return Meal.NONE;
        if (ordinaryRecovery && poultryMeal(stack)) return Meal.POULTRY;
        return fleshMeal(stack) ? Meal.FLESH : Meal.NONE;
    }

    private static boolean positiveNutrition(ItemStack stack) {
        var food = stack.get(DataComponentTypes.FOOD);
        return !stack.isEmpty() && food != null && food.nutrition() > 0;
    }

    static boolean improvisedWeapon(ItemStack stack) {
        return stack.isIn(ItemTags.PICKAXES) && Registries.ITEM.getId(stack.getItem()).getNamespace().equals("minecraft")
            && stack.getMaxDamage() - stack.getDamage() > 2;
    }

    static boolean criticalHuntContact(double squaredDistance, double reach, boolean dryTarget) {
        return dryTarget && reach > 0 && squaredDistance <= reach * reach;
    }

    static boolean safeWeapon(ItemStack stack) {
        // Unlike a charged sword swing, an axe cannot sweep other entities.
        // Reserve more than the maximum two wear of a vanilla axe hit.
        return stack.isIn(ItemTags.AXES)
            && Registries.ITEM.getId(stack.getItem()).getNamespace().equals("minecraft")
            && stack.getMaxDamage() - stack.getDamage() > 2;
    }

    static int pickupGain(int before, int carried, boolean removed, boolean matchingStock) {
        return removed || matchingStock ? Math.max(0, carried - before) : 0;
    }

    static int ordinaryPickupGain(int before, int carried, int witnessed, int remaining) {
        return Math.max(0, Math.min(carried - before, witnessed - remaining));
    }

    static boolean policy(Source source, AgentWorkOrder.Target target, Map<Item, Integer> caps,
                          int effects, int breaks, int crafts, int placements) {
        return source != Source.CHICKEN && target.item() == source.item && caps.isEmpty() && effects == 1
            && breaks == 0 && crafts == 0 && placements == 0;
    }

    private AgentFoodWork() {}
}
