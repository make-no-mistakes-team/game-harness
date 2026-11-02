package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.GuiProductionLedger;
import io.gameharness.nativeclient.GuiTransactionProof;
import net.minecraft.block.BlockState;
import net.minecraft.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.recipe.AbstractCookingRecipe;
import net.minecraft.recipe.RecipeEntry;
import net.minecraft.recipe.input.SingleStackRecipeInput;
import net.minecraft.registry.DynamicRegistryManager;
import net.minecraft.registry.RegistryWrapper;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.collection.DefaultedList;
import net.minecraft.util.math.BlockPos;
import org.spongepowered.asm.mixin.*;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(AbstractFurnaceBlockEntity.class)
public abstract class FurnaceProductionMixin implements GuiTransactionProof.FurnaceAccess {
  @Unique private GuiProductionLedger.Furnace gameharness$ledger;

  @Override public GuiProductionLedger.Furnace guiProductionLedger() {
    if (gameharness$ledger == null) gameharness$ledger = new GuiProductionLedger.Furnace();
    return gameharness$ledger;
  }

  @Shadow private static boolean craftRecipe(DynamicRegistryManager registries,
      RecipeEntry<? extends AbstractCookingRecipe> recipe, SingleStackRecipeInput input,
      DefaultedList<ItemStack> inventory, int maxCount) { throw new AssertionError(); }

  // One call per completed recipe, not every tick; uses the original recipe and original
  // method exactly once. No lookup, recipe scan, copy, gameplay mutation or NBT inspection.
  @Redirect(method = "tick", at = @At(value = "INVOKE",
      target = "Lnet/minecraft/block/entity/AbstractFurnaceBlockEntity;craftRecipe(Lnet/minecraft/registry/DynamicRegistryManager;Lnet/minecraft/recipe/RecipeEntry;Lnet/minecraft/recipe/input/SingleStackRecipeInput;Lnet/minecraft/util/collection/DefaultedList;I)Z"))
  private static boolean recipe(DynamicRegistryManager registries,
      RecipeEntry<? extends AbstractCookingRecipe> recipe, SingleStackRecipeInput input,
      DefaultedList<ItemStack> inventory, int maxCount, ServerWorld world, BlockPos pos,
      BlockState state, AbstractFurnaceBlockEntity furnace) {
    Item inputItem = inventory.get(0).getItem();
    int beforeInput = inventory.get(0).getCount(), beforeOutput = inventory.get(2).getCount();
    boolean crafted = craftRecipe(registries, recipe, input, inventory, maxCount);
    if (crafted) GuiTransactionProof.furnaceRecipe((GuiTransactionProof.FurnaceAccess) furnace,
        inputItem, beforeInput, inventory.get(0).getCount(), inventory.get(2),
        beforeOutput, inventory.get(2).getCount());
    return crafted;
  }

  @Inject(method = "setStack", at = @At("RETURN"))
  private void replaced(int slot, ItemStack stack, CallbackInfo ci) {
    if (gameharness$ledger == null) return;
    if (slot == 0) GuiTransactionProof.furnaceInputWrite(this,
        ((AbstractFurnaceBlockEntity) (Object) this).getStack(0));
  }

  @Inject(method = "setStack", at = @At("HEAD"))
  private void replacingOutput(int slot, ItemStack stack, CallbackInfo ci) {
    if (gameharness$ledger == null || slot != 2) return;
    // tryTakeStackRange removes the result before its already-empty cleanup write and
    // onCrafted callback. Only that no-op write may retain the pending take's provenance.
    gameharness$ledger.setOutput(((AbstractFurnaceBlockEntity) (Object) this).getStack(2).getCount(),
        stack.getCount());
  }

  @Inject(method = "readNbt", at = @At("RETURN"))
  private void reloaded(NbtCompound nbt, RegistryWrapper.WrapperLookup registries, CallbackInfo ci) {
    gameharness$ledger = null;
  }
}
