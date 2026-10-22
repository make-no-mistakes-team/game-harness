package io.gameharness.nativeclient;

import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;

public final class AttackProofClient {
  public static void install() {
    ClientPlayNetworking.registerGlobalReceiver(
        AttackProof.Receipt.ID,
        (r, c) ->
            c.client()
                .execute(
                    () -> {
                      if (NativeClient.INSTANCE != null)
                        NativeClient.INSTANCE.attackReceipt(r.nonce(), r.generation(), r.outcome());
                    }));
  }

  public static void arm(int nonce, long generation) {
    ClientPlayNetworking.send(new AttackProof.Receipt(nonce, generation, -1));
  }
}
