package io.gameharness.survival.mixin;

import io.gameharness.survival.AgentClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Gate scoped vanilla use edges and observe their ordinary main-hand results. */
@Mixin(MinecraftClient.class)
abstract class AgentWaterUseMixin {
    @Inject(method = "doItemUse", at = @At("HEAD"), cancellable = true)
    private void agent$checkWaterUse(CallbackInfo ci) {
        if (!AgentClient.allowScopedWaterUse() || !AgentClient.allowScopedFurnaceUse()) ci.cancel();
    }

    @Redirect(method = "doItemUse", at = @At(value = "INVOKE",
        target = "Lnet/minecraft/client/network/ClientPlayerInteractionManager;interactItem(Lnet/minecraft/entity/player/PlayerEntity;Lnet/minecraft/util/Hand;)Lnet/minecraft/util/ActionResult;"))
    private ActionResult agent$observeWaterUse(ClientPlayerInteractionManager manager, PlayerEntity player, Hand hand) {
        ActionResult result = manager.interactItem(player, hand);
        if (hand == Hand.MAIN_HAND && result.isAccepted()) AgentClient.confirmScopedWaterUse();
        return result;
    }

    @Redirect(method = "doItemUse", at = @At(value = "INVOKE",
        target = "Lnet/minecraft/client/network/ClientPlayerInteractionManager;interactBlock(Lnet/minecraft/client/network/ClientPlayerEntity;Lnet/minecraft/util/Hand;Lnet/minecraft/util/hit/BlockHitResult;)Lnet/minecraft/util/ActionResult;"))
    private ActionResult agent$observeFurnaceUse(ClientPlayerInteractionManager manager, ClientPlayerEntity player,
                                               Hand hand, BlockHitResult hit) {
        ActionResult result = manager.interactBlock(player, hand, hit);
        if (hand == Hand.MAIN_HAND && result.isAccepted()) AgentClient.confirmScopedFurnaceUse(player, hit);
        return result;
    }
}
