package io.gameharness.survival;

import java.util.List;
import net.minecraft.Bootstrap;
import net.minecraft.SharedConstants;
import net.minecraft.block.Blocks;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.component.type.UnbreakableComponent;
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
import org.junit.jupiter.api.Test;

/** Exercises actual vanilla stacks and block states without starting a client or world. */
final class MiningStockProof {
    @Test
    void boundsItemCountLossForRealVanillaStacks() {
        SharedConstants.createGameVersion();
        Bootstrap.initialize();
        // Fabric defers registry freezing until after mod initialization in a game launch.
        Registries.bootstrap();
        try (var packs = new LifecycledResourceManagerImpl(ResourceType.SERVER_DATA,
                List.of(VanillaDataPackProvider.createDefaultPack()))) {
            TagGroupLoader.startReload(packs, DynamicRegistryManager.of(Registries.REGISTRIES))
                .forEach(Registry.PendingTagLoad::apply);
        }
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

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
