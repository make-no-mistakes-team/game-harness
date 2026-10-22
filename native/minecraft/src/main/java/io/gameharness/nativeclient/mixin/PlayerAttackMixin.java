package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.AttackProof;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.server.network.ServerPlayerEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(PlayerEntity.class)
public abstract class PlayerAttackMixin {
  @Inject(method = "attack", at = @At("HEAD"))
  private void before(Entity target, CallbackInfo ci) {
    if ((Object) this instanceof ServerPlayerEntity player) AttackProof.begin(player, target);
  }

  @Inject(method = "attack", at = @At("RETURN"))
  private void after(Entity target, CallbackInfo ci) {
    if ((Object) this instanceof ServerPlayerEntity player) AttackProof.end(player, target);
  }
}
