package io.gameharness.survival;

import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.UnbreakableComponent;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.DynamicRegistryManager;
import net.minecraft.registry.Registry;
import net.minecraft.registry.Registries;
import net.minecraft.registry.tag.TagGroupLoader;
import net.minecraft.resource.LifecycledResourceManagerImpl;
import net.minecraft.resource.ResourceType;
import net.minecraft.resource.VanillaDataPackProvider;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.EmptyBlockView;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Exercises actual vanilla stacks and block states without starting a client or world. */
final class MiningStockProof {
    @BeforeAll
    static void initializeVanilla() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
        // Fabric defers registry freezing until after mod initialization in a game launch.
        Registries.bootstrap();
        try (var packs = new LifecycledResourceManagerImpl(ResourceType.SERVER_DATA,
                List.of(VanillaDataPackProvider.createDefaultPack()))) {
            TagGroupLoader.startReload(packs, DynamicRegistryManager.of(Registries.REGISTRIES))
                .forEach(Registry.PendingTagLoad::apply);
        }
    }

    @Test
    void boundsItemCountLossForRealVanillaStacks() {
        var stone = Blocks.STONE.getDefaultState();
        var log = Blocks.BIRCH_LOG.getDefaultState();
        var world = EmptyBlockView.INSTANCE;
        var pos = BlockPos.ORIGIN;

        require(AgentMiningStock.maxLoss(ItemStack.EMPTY, log, world, pos) == 0, "bare hand uses no stock");
        require(AgentMiningStock.maxLoss(new ItemStack(Items.COBBLESTONE, 12), log, world, pos) == 0,
            "holding a nonwearing material while hitting a block uses none of it");

        var bow = new ItemStack(Items.BOW);
        bow.setDamage(bow.getMaxDamage() - 1);
        require(AgentMiningStock.maxLoss(bow, log, world, pos) == 0, "a damageable non-mining item does not wear");

        var pick = new ItemStack(Items.WOODEN_PICKAXE);
        require(AgentMiningStock.maxLoss(pick, stone, world, pos) == 0, "wear alone does not use stock");
        pick.setDamage(pick.getMaxDamage() - 1);
        require(AgentMiningStock.maxLoss(pick, stone, world, pos) == 1, "a last-use pick can be lost");
        require(AgentMiningStock.maxLoss(pick, Blocks.TORCH.getDefaultState(), world, pos) == 0,
            "ordinary mining tools take no wear from a zero-hardness block");
        pick.set(DataComponentTypes.UNBREAKABLE, new UnbreakableComponent(false));
        require(AgentMiningStock.maxLoss(pick, stone, world, pos) == 0, "the Unbreakable component prevents stock loss");

        var shears = new ItemStack(Items.SHEARS);
        shears.setDamage(shears.getMaxDamage() - 2);
        require(AgentMiningStock.maxLoss(shears, log, world, pos) == 1, "shears can apply their own wear and base tool wear");
        require(AgentMiningStock.maxLoss(shears, Blocks.COBWEB.getDefaultState(), world, pos) == 0,
            "shears skip base tool wear when their override handles the block");

        var sword = new ItemStack(Items.WOODEN_SWORD);
        sword.setDamage(sword.getMaxDamage() - 2);
        require(AgentMiningStock.maxLoss(sword, log, world, pos) == 1, "two points of tool wear can exhaust two remaining");
    }

    @Test
    void reservesAStartingLogAndProcuresOnlyCompatibleWood() {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.OAK_PLANKS, 4, null),
            Set.of("craft:planks", "break:minecraft:oak_log"), Map.of(Items.OAK_LOG, 1), Map.of(Items.OAK_LOG, 1), 1, 1, 0);
        var remaining = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(3, new ItemStack(Items.OAK_LOG));
        stock.setStack(8, new ItemStack(Items.SPRUCE_LOG, 4));
        var missing = AgentHands.workNeed(stock, "oak_planks", remaining);
        require(policy.craftAllowed("oak_planks"), "generic plank permission can bind an exact oak output");
        require(missing != null && missing.count() == 1 && missing.matches(new ItemStack(Items.OAK_LOG))
            && !missing.matches(new ItemStack(Items.SPRUCE_LOG)), "protected stock does not satisfy the exact input");
        stock.setStack(16, new ItemStack(Items.OAK_LOG));
        require(AgentHands.workNeed(stock, "oak_planks", remaining) == null, "the newly acquired log supplies the recipe");
        require(remaining.limit(Items.OAK_LOG, 2) == 1, "only one of two logs is spendable");
        remaining.crafted(Map.of(Items.OAK_LOG, 1), 1);
        require(remaining.limit(Items.OAK_LOG, 3) == 0 && remaining.craftsLeft() == 0,
            "more stock does not replenish the already charged permission");
    }

    @Test
    void appliesTheSameRuleToANonWoodIngredient() {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.TORCH, 8, null),
            Set.of("craft:torch", "break:minecraft:coal_ore"), Map.of(Items.COAL, 2, Items.STICK, 2),
            Map.of(Items.COAL, 1), 2, 2, 0);
        var budget = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.COAL));
        stock.setStack(11, new ItemStack(Items.STICK, 2));
        var missing = AgentHands.workNeed(stock, "torch", budget);
        require(missing != null && missing.matches(new ItemStack(Items.COAL)), "last coal is not a crafting ingredient");
        require(!missing.matches(new ItemStack(Items.STICK)), "a surplus of other recipe inputs cannot hide missing coal");
        stock.setStack(0, ItemStack.EMPTY);
        stock.setStack(35, new ItemStack(Items.COAL, 2));
        require(AgentHands.workNeed(stock, "torch", budget) == null && budget.limit(Items.COAL, 2) == 1,
            "slot changes leave one legal execution, not a two-execution batch");
    }

    @Test
    void acquiresAReserveWithoutTreatingItAsAlreadyHeld() {
        var policy = new AgentWorkOrder.Policy(false, new AgentWorkOrder.Target(Items.TORCH, 4, null),
            Set.of("craft:torch", "craft:stick"), Map.of(Items.OAK_PLANKS, 2, Items.COAL, 1, Items.STICK, 1),
            Map.of(Items.TORCH, 4), 0, 2, 0);
        var budget = new AgentWorkOrder.Budget(policy);
        var stock = new PlayerInventory(null);
        stock.setStack(0, new ItemStack(Items.OAK_PLANKS, 2));
        stock.setStack(1, new ItemStack(Items.COAL));
        require(budget.missingFloor(stock).getKey() == Items.TORCH
                && AgentWorkOrder.count(stock, Items.TORCH) == 0,
            "a declared final reserve is not an observed item");
        require(budget.limit(Items.OAK_PLANKS, 2) == 2 && AgentHands.workNeed(stock, "stick", budget) == null,
            "producing a different prerequisite is legal without consuming the absent reserve");
        var next = AgentHands.workNeed(stock, "torch", budget);
        require(next != null && next.matches(new ItemStack(Items.STICK)), "torch procurement still requires an actual stick");
        stock.setStack(2, new ItemStack(Items.STICK, 4));
        stock.setStack(3, new ItemStack(Items.TORCH, 3));
        require(AgentHands.workNeed(stock, "torch", budget) == null && budget.missingFloor(stock) != null,
            "craft is now possible, but stock does not yet meet the final reserve");
        stock.setStack(3, new ItemStack(Items.TORCH, 4));
        require(budget.missingFloor(stock) == null && budget.limit(Items.TORCH, 4) == 0,
            "only the observed output fulfills the reserve, and it cannot be spent");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
