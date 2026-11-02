package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;

/** Diagnostics bracket actual ordinary vanilla packets; this transport never changes gameplay. */
public final class GuiTransactionProofClient {
  public static void install() {
    ClientPlayNetworking.registerGlobalReceiver(GuiTransactionProof.Message.ID, (receipt, context) ->
        context.client().execute(() -> VisibleScreen.receipt(receipt.nonce(), receipt.generation(), receipt.contents())));
  }
  /** True means queued locally, never a server acknowledgement or proof of retirement. */
  public static boolean request(ClientPlayNetworkHandler connection, int nonce, long generation, String phase, int sync) {
    try {
      if (connection == null || MinecraftClient.getInstance().getNetworkHandler() != connection) return false;
      JsonObject body = new JsonObject(); body.addProperty("phase", phase); body.addProperty("sync_id", sync);
      ClientPlayNetworking.send(new GuiTransactionProof.Message(nonce, generation, body.toString()));
      return true;
    } catch (RuntimeException unavailable) { return false; }
  }
  private GuiTransactionProofClient() {}
}
