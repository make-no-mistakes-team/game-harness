package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientWorld.class)
public abstract class EntityScopeMixin {
  @Inject(method = "addEntity", at = @At("TAIL"))
  private void added(Entity entity, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.entityReplaced(entity);
  }

  @Inject(method = "removeEntity", at = @At("HEAD"))
  private void removing(int id, Entity.RemovalReason reason, CallbackInfo ci) {
    Entity entity = ((ClientWorld) (Object) this).getEntityById(id);
    if (entity != null && NativeClient.INSTANCE != null) NativeClient.INSTANCE.entityReplaced(entity);
  }
}
