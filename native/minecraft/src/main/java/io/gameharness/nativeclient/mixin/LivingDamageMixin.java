package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.AttackProof;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.damage.DamageSource;
import net.minecraft.server.world.ServerWorld;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(LivingEntity.class)
public abstract class LivingDamageMixin {
  @Inject(method = "damage", at = @At("RETURN"))
  private void result(
      ServerWorld world, DamageSource source, float amount, CallbackInfoReturnable<Boolean> ci) {
    AttackProof.damage((Entity) (Object) this, source.getAttacker(), ci.getReturnValue());
  }
}
