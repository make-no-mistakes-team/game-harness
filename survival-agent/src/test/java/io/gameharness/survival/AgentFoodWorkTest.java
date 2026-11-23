package io.gameharness.survival;

import static org.junit.jupiter.api.Assertions.*;

import com.google.gson.JsonParser;
import net.minecraft.block.Blocks;
import net.minecraft.block.CaveVines;
import net.minecraft.block.LeavesBlock;
import net.minecraft.block.SweetBerryBushBlock;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

final class AgentFoodWorkTest {
    @BeforeAll
    static void initializeVanilla() { VanillaTestResources.initialize(); }

    @Test
    void exactFoodWorkCannotSpendOrRenew() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"meal","run":"run","life":1,"epoch":1,"basisTick":10,"expiresTick":120,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:porkchop","count":1},
             "allowedEffects":["forage:entity:minecraft:pig"],
             "maxBreaks":0,"maxCrafts":0,"maxPlacements":0,"costCaps":[],"reserves":[]}
            """).getAsJsonObject();
        var order = AgentWorkOrder.parse(raw, "run", "constrained");
        assertEquals(AgentFoodWork.Source.PIG, order.policy().foodSource());
        assertFalse(order.policy().pendingOrdinary());
        var extended = raw.deepCopy();
        extended.addProperty("expiresTick", 150);
        assertFalse(AgentMacroControl.canRenewWork(order, order, AgentWorkOrder.parse(extended, "run", "constrained")));
        var spends = raw.deepCopy();
        spends.add("costCaps", JsonParser.parseString("[{\"item\":\"minecraft:wooden_axe\",\"count\":1}]"));
        assertNull(AgentWorkOrder.parse(spends, "run", "constrained").policy());
        raw.getAsJsonObject("target").addProperty("item", "minecraft:beef");
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy());
    }

    @Test
    void ordinaryPoultryDoesNotAuthorizeAnExactForageEffect() {
        var raw = JsonParser.parseString("""
            {"v":1,"id":"poultry","run":"run","life":1,"epoch":1,"basisTick":10,"expiresTick":120,
             "safetyRevision":1,"origin":"model","target":{"kind":"stock","item":"minecraft:chicken","count":1},
             "allowedEffects":["forage:entity:minecraft:chicken"],
             "maxBreaks":0,"maxCrafts":0,"maxPlacements":0,"costCaps":[],"reserves":[]}
            """).getAsJsonObject();
        assertNull(AgentWorkOrder.parse(raw, "run", "constrained").policy());
    }

    @Test
    void contactRequiresRipeFoodAndAnAxeThatCannotBreakOnTheNextHit() {
        var bush = Blocks.SWEET_BERRY_BUSH.getDefaultState();
        assertNull(AgentFoodWork.ripe(bush.with(SweetBerryBushBlock.AGE, 1)));
        assertEquals(AgentFoodWork.Source.SWEET_BERRIES, AgentFoodWork.ripe(bush.with(SweetBerryBushBlock.AGE, 2)));
        var vines = Blocks.CAVE_VINES_PLANT.getDefaultState();
        assertNull(AgentFoodWork.ripe(vines.with(CaveVines.BERRIES, false)));
        assertEquals(AgentFoodWork.Source.GLOW_PLANT, AgentFoodWork.ripe(vines.with(CaveVines.BERRIES, true)));
        assertFalse(AgentFoodWork.safeWeapon(new ItemStack(Items.WOODEN_PICKAXE)));
        assertFalse(AgentFoodWork.safeWeapon(new ItemStack(Items.WOODEN_SWORD)), "sweeps are not exact contacts");
        var axe = new ItemStack(Items.WOODEN_AXE);
        axe.setDamage(axe.getMaxDamage() - 3);
        assertTrue(AgentFoodWork.safeWeapon(axe));
        axe.setDamage(axe.getMaxDamage() - 2);
        assertFalse(AgentFoodWork.safeWeapon(axe));
    }

    @Test
    void aWitnessedPickupDeltaIsNotAStoredStockPromiseAfterEating() {
        assertEquals(2, AgentFoodWork.pickupGain(0, 2, true, false));
        assertEquals(0, AgentFoodWork.pickupGain(0, 2, false, false));
        assertEquals(2, AgentFoodWork.pickupGain(0, 2, false, true));
        assertEquals(0, AgentFoodWork.pickupGain(2, 1, true, true), "a later meal is not additional loot");
    }

    @Test
    void aHalfHeartPlayerKeepsTheHealingTurnAcrossDaysOfMisses() {
        var goal = new AgentFoodWork.HealingGoal();
        assertFalse(goal.update(16, 20, 20));
        for (int tick = 0; tick < 72_000; tick++) {
            assertTrue(goal.update(16, 0.833f, 20), "no-source and cooldown ticks must not yield to ore");
            assertFalse(goal.canRest(16));
        }
        assertTrue(goal.update(18, 0.833f, 20), "a meal is not yet a recovery");
        assertTrue(goal.canRest(18));
        assertTrue(goal.update(17, 12, 20), "falling below healing hunger resumes the food search");
        assertFalse(goal.canRest(17));
        goal.reset();
        assertTrue(goal.update(17, 12.2f, 20), "reopening the same injured player cannot erase the need to eat");
        assertFalse(goal.update(18, 14, 20), "ordinary work returns only after a safe recovery");
    }

    @Test
    void visibleAdultBeyondMeleeReachIsApproachedButNotAttackedWhileUnsafe() {
        assertEquals(AgentFoodWork.SourceAction.APPROACH, AgentFoodWork.huntAction(6 * 6, 2.8, true, true));
        assertEquals(AgentFoodWork.SourceAction.CONTACT, AgentFoodWork.huntAction(2 * 2, 2.8, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.huntAction(6 * 6, 2.8, false, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.huntAction(2 * 2, 2.8, false, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.huntAction(6 * 6, 2.8, true, false));
    }

    @Test
    void visibleGroundedDropIsApproachedUntilActualPickupOverlap() {
        var standing = new Box(-0.3, 64, -0.3, 0.3, 65.8, 0.3);
        var drop = new Box(7, 64, 0, 7.25, 64.25, 0.25);
        assertEquals(AgentFoodWork.SourceAction.APPROACH, AgentFoodWork.dropAction(standing, drop, true, true, true));
        assertEquals(AgentFoodWork.SourceAction.CONTACT,
            AgentFoodWork.dropAction(standing.offset(6, 0, 0), drop, true, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, drop, false, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, drop, true, false, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, drop, true, true, false));
    }

    @Test
    void fallingFoodBelowThePickupEnvelopeCannotRequestMovement() {
        var standing = new Box(-0.3, 64, -0.3, 0.3, 65.8, 0.3);
        var apple = new Box(0.25, 63.3, 0, 0.5, 63.55, 0.25);
        assertEquals(AgentFoodWork.SourceAction.CONTACT, AgentFoodWork.dropAction(standing, apple, false, true, true));
        var missed = apple.offset(0, -0.2, 0);
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, missed, false, true, true));
        assertEquals(AgentFoodWork.SourceAction.REFUSE, AgentFoodWork.dropAction(standing, missed, true, true, false));
        assertEquals(AgentFoodWork.SourceAction.APPROACH, AgentFoodWork.dropAction(standing, missed, true, true, true));
        var lowerFoot = AgentFoodWork.dropStance(missed, standing.maxY - standing.minY);
        assertFalse(lowerFoot.reached(new Vec3d(0.375, 64, 0.125)),
            "the navigator must not count the lip above the item as arrival");
        assertTrue(lowerFoot.reached(new Vec3d(0.375, 63, 0.125)));
    }

    @Test
    void aForageFaceNeedsAppleBearingLeavesAndACollectibleLanding() {
        var foot = new BlockPos(0, 64, 0);
        var player = new Box(0.2, 64, 0.2, 0.8, 65.8, 0.8);
        var next = foot.east();
        assertTrue(AgentFoodWork.appleLeaf(Blocks.OAK_LEAVES.getDefaultState()));
        assertTrue(AgentFoodWork.appleLeaf(Blocks.DARK_OAK_LEAVES.getDefaultState()));
        assertFalse(AgentFoodWork.appleLeaf(Blocks.BIRCH_LEAVES.getDefaultState()));
        assertFalse(AgentFoodWork.appleLeaf(Blocks.OAK_LEAVES.getDefaultState().with(LeavesBlock.WATERLOGGED, true)));
        assertFalse(AgentFoodWork.leafClearOfStance(foot, player, foot.down()));
        assertFalse(AgentFoodWork.leafClearOfStance(foot, player, foot.up()));
        assertTrue(AgentFoodWork.leafClearOfStance(foot, player, next));
        assertTrue(AgentFoodWork.appleCatch(player, next.getX(), 64, next.getZ()));
        assertFalse(AgentFoodWork.appleCatch(player, next.getX(), 63, next.getZ()));
        assertFalse(AgentFoodWork.appleCatch(player, next.getX() + 1, 64, next.getZ()));
    }

    @Test
    void lowerForageCueNamesABearingNotAnUnseenLanding() {
        var foot = new BlockPos(0, 72, 0);
        assertEquals(Direction.EAST, AgentFoodWork.lowerForageBearing(foot, foot.east(4).down(5)));
        assertEquals(Direction.NORTH, AgentFoodWork.lowerForageBearing(foot, foot.north(3).west().down(2)));
        assertNull(AgentFoodWork.lowerForageBearing(foot, foot.down(4)));
        assertNull(AgentFoodWork.lowerForageBearing(foot, foot.east(4).down()));

        var leaves = Blocks.OAK_LEAVES.getDefaultState();
        var grass = Blocks.GRASS_BLOCK.getDefaultState();
        var shelf = foot.east().down();
        assertNotNull(AgentFoodWork.canopyEdge(foot, leaves, Direction.EAST, shelf, grass));
        assertNull(AgentFoodWork.canopyEdge(foot, leaves, Direction.EAST, foot.east(4).down(5), grass));
        assertNull(AgentFoodWork.canopyEdge(foot, leaves, Direction.EAST, shelf, Blocks.SAND.getDefaultState()));
        assertNull(AgentFoodWork.canopyEdge(foot, leaves, Direction.EAST, shelf,
            leaves.with(LeavesBlock.WATERLOGGED, true)));
    }

    @Test
    void canopyOpeningCannotCutCurrentOrProtectedSupport() {
        var foot = new BlockPos(0, 72, 0);
        var player = new Box(0.2, 72, 0.2, 0.8, 73.8, 0.8);
        var leaves = Blocks.BIRCH_LEAVES.getDefaultState();
        var adjacentTop = foot.east().down();
        var mask = new BlockHitResult(new Vec3d(1.5, 72, 0.5), Direction.UP, adjacentTop, false);
        assertTrue(AgentFoodWork.canopyMask(foot, player, Direction.EAST, mask, leaves, false));
        assertFalse(AgentFoodWork.canopyMask(foot, player.offset(0.17, 0, 0), Direction.EAST, mask, leaves, false),
            "the stationary box plus safety margin overlaps the proposed mask");
        assertFalse(AgentFoodWork.canopyMask(foot, player, Direction.EAST, mask, leaves, true));
        assertFalse(AgentFoodWork.canopyMask(foot, player, Direction.WEST, mask, leaves, false));
        assertFalse(AgentFoodWork.canopyMask(foot, player, Direction.EAST, mask,
            leaves.with(LeavesBlock.WATERLOGGED, true), false));
        var ownSupport = new BlockHitResult(new Vec3d(0.5, 72, 0.5), Direction.UP, foot.down(), false);
        assertFalse(AgentFoodWork.canopyMask(foot, player, Direction.EAST, ownSupport, leaves, false));
    }

    @Test
    void foodScoutOnlyAdmitsAShortDropWithNoExpectedDamage() {
        assertTrue(AgentFoodWork.canopyDropAllowed(1, 1.4, 0));
        assertTrue(AgentFoodWork.canopyDropAllowed(2, 3, 0));
        assertFalse(AgentFoodWork.canopyDropAllowed(2, 2.2, 0));
        assertFalse(AgentFoodWork.canopyDropAllowed(2, 3, 0.2));
        assertFalse(AgentFoodWork.canopyDropAllowed(3, 10, 0));
    }

    @Test
    void anAppleStandTriesSeveralDifferentFacesButCannotRoamOrCycleOneFace() {
        var stand = new AgentFoodWork.AppleStand();
        var foot = new BlockPos(0, 64, 0);
        assertTrue(stand.canStart(foot, 100));
        stand.start(foot, 100);
        for (int n = 0; n < AgentFoodWork.AppleStand.MAX_FACES; n++) {
            var face = foot.east(n + 1);
            assertTrue(stand.canTry(face, 100 + n));
            stand.tryFace(face, 100 + n);
            assertFalse(stand.canTry(face, 100 + n));
        }
        assertFalse(stand.canTry(foot.west(), 108));
        assertFalse(stand.active(foot.east(), 108));
        assertFalse(stand.canStart(foot, 108));
        assertFalse(stand.canStart(foot.east(), 108), "stepping beside the same crown doesn't start a fresh stand");
        assertTrue(stand.canStart(foot.east(5), 108), "a genuinely different cluster can still be tried");
        assertTrue(stand.canStart(foot, 100 + AgentFoodWork.AppleStand.RETRY_TICKS));
    }

    @Test
    void aMealReceiptNeedsObservedConsumptionAndHungerGain() {
        assertTrue(AgentFoodWork.mealConfirmed(16, 19, 2, 1));
        assertFalse(AgentFoodWork.mealConfirmed(16, 16, 2, 1));
        assertFalse(AgentFoodWork.mealConfirmed(16, 19, 2, 2));
    }

    @Test
    void aRiskyMealIsLimitedToActualRottenFlesh() {
        var flesh = new ItemStack(Items.ROTTEN_FLESH, 2);
        assertFalse(AgentFoodWork.safeMeal(flesh));
        assertTrue(AgentFoodWork.fleshMeal(flesh));
        assertTrue(AgentFoodWork.safeMeal(new ItemStack(Items.SWEET_BERRIES)));
        for (var item : new net.minecraft.item.Item[] {Items.SPIDER_EYE, Items.POISONOUS_POTATO,
                Items.PUFFERFISH, Items.CHICKEN, Items.SUSPICIOUS_STEW, Items.CHORUS_FRUIT, Items.DIRT}) {
            var stack = new ItemStack(item);
            assertFalse(AgentFoodWork.safeMeal(stack));
            assertFalse(AgentFoodWork.fleshMeal(stack));
        }
        assertFalse(AgentFoodWork.fleshMeal(ItemStack.EMPTY));
    }

    @Test
    void onlyOrdinaryEmergencyMealsPreferRawChickenToRottenFlesh() {
        var raw = new ItemStack(Items.CHICKEN);
        var cooked = new ItemStack(Items.COOKED_CHICKEN);
        var flesh = new ItemStack(Items.ROTTEN_FLESH);
        assertEquals(AgentFoodWork.Meal.NONE, AgentFoodWork.mealPriority(raw, false, true));
        assertEquals(AgentFoodWork.Meal.NONE, AgentFoodWork.mealPriority(raw, true, false));
        assertEquals(AgentFoodWork.Meal.FLESH, AgentFoodWork.mealPriority(flesh, true, false));
        assertEquals(AgentFoodWork.Meal.POULTRY, AgentFoodWork.mealPriority(raw, true, true));
        assertEquals(AgentFoodWork.Meal.SAFE, AgentFoodWork.mealPriority(cooked, false, false));
        assertTrue(AgentFoodWork.mealPriority(cooked, true, true).compareTo(
            AgentFoodWork.mealPriority(raw, true, true)) > 0);
        assertTrue(AgentFoodWork.mealPriority(raw, true, true).compareTo(
            AgentFoodWork.mealPriority(flesh, true, true)) > 0);
        assertEquals(AgentFoodWork.Meal.NONE, AgentFoodWork.mealPriority(new ItemStack(Items.SPIDER_EYE), true, true));
    }

    @Test
    void poultryHearingGrantsOneCoarseLookOnlyFromAStoppedHandoff() {
        var look = new AgentFoodWork.PoultryLook();
        var looking = AgentFoodWork.PoultryLook.View.LOOKING;
        var handoff = AgentFoodWork.PoultryLook.View.SCOUT_HANDOFF;
        var foot = new BlockPos(9, 65, -4);
        assertFalse(look.begin(90, null, 30, 20, true), "no safe stopped foothold");
        assertFalse(look.begin(Float.NaN, foot, 30, 20, true), "no audible bearing");
        assertTrue(look.begin(90, foot, 30, 20, true));
        assertEquals(90f, look.bearing());
        assertEquals(looking, look.awaitView(foot, 31, 20, true), "a preexisting view is not the response to the cue");
        assertEquals(handoff, look.awaitView(foot, 32, 21, true), "resume the actual deferred handoff");
        assertFalse(look.begin(-90, foot, 33, 21, true), "fresh calls cannot trigger repeated spins in the recovery");
        look.reset();
        assertTrue(look.begin(-90, foot, 90, 22, true));
        assertEquals(AgentFoodWork.PoultryLook.View.FINISHED, look.awaitView(foot.east(), 91, 23, false),
            "leaving the stopped foothold ends the look without a completed handoff");
    }

    @Test
    void poultryLookCannotOwnTheViewIndefinitely() {
        var look = new AgentFoodWork.PoultryLook();
        var foot = new BlockPos(9, 65, -4);
        assertTrue(look.begin(90, foot, 30, 20, false));
        for (int tick = 31; tick < 70 && look.active(); tick++) look.awaitView(foot, tick, 20, false);
        assertFalse(look.active(), "no render must not hold input indefinitely");
        assertFalse(look.available(), "a missed view cannot request a second turn");
    }

    @Test
    void poultryBearingRejectsOutOfRangeAndUnlocalizableSounds() {
        assertEquals(-45f, AgentEars.poultryBearing(4, 2, 5, 16));
        assertTrue(Float.isNaN(AgentEars.poultryBearing(4, 2, 5, 6)));
        assertTrue(Float.isNaN(AgentEars.poultryBearing(13, 0, 0, 16)));
        assertTrue(Float.isNaN(AgentEars.poultryBearing(0, 2, 0, 16)));
    }

    @Test
    void anExactDropReceiptRequiresBothMatchingStockGainAndWitnessedDepletion() {
        assertEquals(1, AgentFoodWork.ordinaryPickupGain(0, 1, 3, 2));
        assertEquals(2, AgentFoodWork.ordinaryPickupGain(0, 3, 2, 0), "never count more than the sighting held");
        assertEquals(0, AgentFoodWork.ordinaryPickupGain(0, 2, 3, 3), "unrelated gain is not the sighted drop");
        assertEquals(0, AgentFoodWork.ordinaryPickupGain(1, 1, 2, 0), "a vanishing drop is not a pickup");
    }

    @Test
    void anImprovisedHuntCanUseAWoodenPickButCannotBreakItOrChase() {
        var pick = new ItemStack(Items.WOODEN_PICKAXE);
        assertTrue(AgentFoodWork.improvisedWeapon(pick));
        pick.setDamage(pick.getMaxDamage() - 2);
        assertFalse(AgentFoodWork.improvisedWeapon(pick));
        assertFalse(AgentFoodWork.improvisedWeapon(ItemStack.EMPTY));
        assertFalse(AgentFoodWork.improvisedWeapon(new ItemStack(Items.STICK)));
        assertTrue(AgentFoodWork.criticalHuntContact(6, 2.8, true));
        assertFalse(AgentFoodWork.criticalHuntContact(9, 2.8, true));
        assertFalse(AgentFoodWork.criticalHuntContact(6, 2.8, false));
    }
}
