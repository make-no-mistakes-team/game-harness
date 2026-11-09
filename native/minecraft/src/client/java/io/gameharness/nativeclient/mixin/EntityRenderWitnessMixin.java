package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.entity.EntityRenderDispatcher;
import net.minecraft.client.render.entity.EntityRenderer;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.entity.Entity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(EntityRenderDispatcher.class)
public abstract class EntityRenderWitnessMixin {
  @Inject(method = "render(Lnet/minecraft/entity/Entity;DDDFLnet/minecraft/client/util/math/MatrixStack;Lnet/minecraft/client/render/VertexConsumerProvider;ILnet/minecraft/client/render/entity/EntityRenderer;)V",
      at = @At(value = "INVOKE",
          target = "Lnet/minecraft/client/render/entity/EntityRenderer;render(Lnet/minecraft/client/render/entity/state/EntityRenderState;Lnet/minecraft/client/util/math/MatrixStack;Lnet/minecraft/client/render/VertexConsumerProvider;I)V",
          shift = At.Shift.AFTER))
  private void rendered(Entity entity, double x, double y, double z, float tickDelta,
      MatrixStack matrices, VertexConsumerProvider vertices, int light, EntityRenderer<?, ?> renderer, CallbackInfo ci) {
    if (renderer instanceof net.minecraft.client.render.entity.EmptyEntityRenderer<?>) return;
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.entityRendered(entity, x, y, z, matrices);
  }
}
