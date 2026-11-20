package io.gameharness.survival.mixin;

import io.gameharness.survival.AgentClient;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerInteractionManager;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Veto a stale queued bucket edge and observe vanilla's ordinary main-hand result. */
@Mixin(MinecraftClient.class)
abstract class AgentWaterUseMixin {
    @Inject(method = "doItemUse", at = @At("HEAD"), cancellable = true)
    private void agent$checkWaterUse(CallbackInfo ci) {
        if (!AgentClient.allowScopedWaterUse()) ci.cancel();
    }

    @Redirect(method = "doItemUse", at = @At(value = "INVOKE",
        target = "Lnet/minecraft/client/network/ClientPlayerInteractionManager;interactItem(Lnet/minecraft/entity/player/PlayerEntity;Lnet/minecraft/util/Hand;)Lnet/minecraft/util/ActionResult;"))
    private ActionResult agent$observeWaterUse(ClientPlayerInteractionManager manager, PlayerEntity player, Hand hand) {
        ActionResult result = manager.interactItem(player, hand);
        if (hand == Hand.MAIN_HAND && result.isAccepted()) AgentClient.confirmScopedWaterUse();
        return result;
    }
}
