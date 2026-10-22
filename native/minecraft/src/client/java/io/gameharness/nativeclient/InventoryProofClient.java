package io.gameharness.nativeclient;

import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;

public final class InventoryProofClient {
  public static void install() {
    ClientPlayNetworking.registerGlobalReceiver(
        InventoryProof.Receipt.ID,
        (receipt, context) ->
            context
                .client()
                .execute(
                    () -> {
                      if (NativeClient.INSTANCE != null)
                        NativeClient.INSTANCE.inventoryReceipt(
                            receipt.nonce(), receipt.generation(), receipt.contents());
                    }));
  }

  public static void request(int nonce, long generation) {
    ClientPlayNetworking.send(new InventoryProof.Receipt(nonce, generation, ""));
  }
}
