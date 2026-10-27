package io.gameharness.nativeclient.mixin;

import net.minecraft.block.BlockState;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemPlacementContext;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Read-only vanilla placement preflight; never calls use/place or mutates the world. */
@Mixin(BlockItem.class)
public interface BlockItemPlacementAccess {
  @Invoker("getPlacementState")
  BlockState gameharness$getPlacementState(ItemPlacementContext context);
}
