package io.gameharness.nativeclient;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.networking.v1.ClientLoginNetworking;
import net.fabricmc.fabric.api.networking.v1.PacketByteBufs;
import net.minecraft.network.PacketByteBuf;

/** Uses only the supervisor's private session file; no account/name trust or commands. */
public final class AdmissionClient {
  private AdmissionClient() {}

  public static void install() {
    boolean registered =
        ClientLoginNetworking.registerGlobalReceiver(
            Admission.CHANNEL,
            (client, handler, buf, callbacksConsumer) -> {
              if (buf.readableBytes() != Admission.WIRE_BYTES
                  || buf.readUnsignedByte() != Admission.VERSION) {
                return CompletableFuture.completedFuture(null);
              }
              byte[] nonce = new byte[Admission.NONCE_BYTES];
              buf.readBytes(nonce);
              try {
                Admission.Session session =
                    Admission.readSession(System.getProperty("gameharness.session"));
                try {
                  byte[] proof = Admission.proof(session, nonce);
                  try {
                    PacketByteBuf response = PacketByteBufs.create();
                    response.writeByte(Admission.VERSION);
                    response.writeBytes(proof);
                    return CompletableFuture.completedFuture(response);
                  } finally {
                    Arrays.fill(proof, (byte) 0);
                  }
                } finally {
                  session.clear();
                }
              } catch (IOException | GeneralSecurityException ignored) {
                // Fabric encodes null as an unrecognized query. Server admission fails
                // closed; neither the session file nor exception details reach a log/UI.
                return CompletableFuture.completedFuture(null);
              } finally {
                Arrays.fill(nonce, (byte) 0);
              }
            });
    if (!registered) throw new IllegalStateException("Managed admission registration failed");
  }
}
