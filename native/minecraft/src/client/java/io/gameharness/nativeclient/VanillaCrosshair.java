package io.gameharness.nativeclient;

import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.EntityHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;

/** Target selection is not authority to send a packet outside the ordinary crosshair. */
final class VanillaCrosshair {
  private VanillaCrosshair() {}

  static HitResult current(MinecraftClient client) {
    // Semantic effects run at START_CLIENT_TICK, before vanilla refreshes its
    // cached crosshair. Use vanilla's current-pose/reach/occlusion calculation.
    client.gameRenderer.updateCrosshairTarget(1);
    return client.crosshairTarget;
  }

  static BlockHitResult block(HitResult hit, BlockPos target) {
    return target != null && hit instanceof BlockHitResult block
        && hit.getType() == HitResult.Type.BLOCK && block.getBlockPos().equals(target)
        ? block : null;
  }

  static boolean entity(HitResult hit, Entity target) {
    return target != null && hit instanceof EntityHitResult entity
        && entity.getEntity() == target;
  }
}
