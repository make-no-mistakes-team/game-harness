package io.gameharness.nativeclient.mixin;

import io.gameharness.nativeclient.NativeClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.BlockUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.ChunkDeltaUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.HealthUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.PlayerActionResponseS2CPacket;
import net.minecraft.network.packet.s2c.play.PlayerRespawnS2CPacket;
import net.minecraft.network.packet.s2c.play.PlayerPositionLookS2CPacket;
import net.minecraft.network.packet.s2c.play.GameJoinS2CPacket;
import net.minecraft.network.packet.s2c.play.ScreenHandlerSlotUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.InventoryS2CPacket;
import net.minecraft.network.packet.s2c.play.SetCursorItemS2CPacket;
import net.minecraft.network.packet.s2c.play.SetPlayerInventoryS2CPacket;
import net.minecraft.network.packet.s2c.play.UpdateSelectedSlotS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientPlayNetworkHandler.class)
public abstract class NetworkEvidenceMixin {
  @Inject(method = "onGameJoin", at = @At("TAIL"))
  private void joined(GameJoinS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.spaceReceived();
  }

  @Inject(method = "unloadWorld", at = @At("HEAD"))
  private void unloading(CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.scopeUnavailable();
  }

  @Inject(method = "onPlayerRespawn", at = @At("TAIL"))
  private void respawn(PlayerRespawnS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.playerRespawned();
  }

  @Inject(method = "onPlayerPositionLook", at = @At("TAIL"))
  private void position(PlayerPositionLookS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.playerPositionReceived();
  }

  @Inject(method = "onHealthUpdate", at = @At("TAIL"))
  private void health(HealthUpdateS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.healthUpdated(packet.getHealth());
  }

  @Inject(method = "onBlockUpdate", at = @At("TAIL"))
  private void block(BlockUpdateS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.blockUpdated(packet.getPos());
  }

  @Inject(method = "onChunkDeltaUpdate", at = @At("TAIL"))
  private void delta(ChunkDeltaUpdateS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null)
      packet.visitUpdates((pos, state) -> NativeClient.INSTANCE.blockUpdated(pos));
  }

  @Inject(method = "onPlayerActionResponse", at = @At("TAIL"))
  private void acknowledged(PlayerActionResponseS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.actionAcknowledged(packet.sequence());
  }

  @Inject(method = "onScreenHandlerSlotUpdate", at = @At("TAIL"))
  private void slot(ScreenHandlerSlotUpdateS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.screenTransactionReceived(packet.getSyncId());
  }

  @Inject(method = "onInventory", at = @At("TAIL"))
  private void inventory(InventoryS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.screenTransactionReceived(packet.getSyncId());
  }

  @Inject(method = "onSetCursorItem", at = @At("TAIL"))
  private void cursor(SetCursorItemS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.screenTransactionReceived();
  }

  @Inject(method = "onSetPlayerInventory", at = @At("TAIL"))
  private void playerInventory(SetPlayerInventoryS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.screenTransactionReceived();
  }

  @Inject(method = "onUpdateSelectedSlot", at = @At("TAIL"))
  private void selected(UpdateSelectedSlotS2CPacket packet, CallbackInfo ci) {
    if (NativeClient.INSTANCE != null) NativeClient.INSTANCE.screenTransactionReceived();
  }
}
