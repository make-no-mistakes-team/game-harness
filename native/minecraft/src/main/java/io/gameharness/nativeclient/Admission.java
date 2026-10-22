package io.gameharness.nativeclient;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.PacketByteBufs;
import net.fabricmc.fabric.api.networking.v1.ServerLoginConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerLoginNetworking;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
// Fabric API 0.119.4 + Minecraft 1.21.4 supplies this pinned accessor.
// It avoids treating any protocol-handler transition as a physical disconnect.
import net.fabricmc.fabric.mixin.networking.accessor.ServerLoginNetworkHandlerAccessor;
import net.minecraft.network.ClientConnection;
import net.minecraft.network.PacketByteBuf;
import net.minecraft.server.MinecraftServer;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;

/** Private login proof, completed before Fabric permits vanilla tickVerify. */
public final class Admission implements ModInitializer {
  static final Identifier CHANNEL = Identifier.of("gameharness", "admission_v1");
  static final int VERSION = 1;
  static final int NONCE_BYTES = 32;
  static final int WIRE_BYTES = 1 + NONCE_BYTES;
  private static final long PROOF_TIMEOUT = TimeUnit.SECONDS.toNanos(10);
  private static final long JOIN_TIMEOUT = TimeUnit.SECONDS.toNanos(30);
  private static final long ROTATION_INTERVAL = TimeUnit.SECONDS.toNanos(1);
  private static final int MAX_PENDING = 32;
  private static final Text DENIED = Text.literal("Managed client admission unavailable.");
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final byte[] DOMAIN =
      "gameharness/admission/v1\0".getBytes(StandardCharsets.US_ASCII);

  private final Object lock = new Object();
  private final Map<ClientConnection, Attempt> attempts = new IdentityHashMap<>();
  private Attempt owner;
  private long nextRotationCheck;
  private ScheduledExecutorService timer;
  private boolean stopping;

  @Override
  public void onInitialize() {
    boolean registered =
        ServerLoginNetworking.registerGlobalReceiver(
            CHANNEL,
            (server, handler, understood, buf, synchronizer, sender) -> {
              ClientConnection connection =
                  ((ServerLoginNetworkHandlerAccessor) handler).getConnection();
              receive(connection, understood, buf);
            });
    if (!registered) throw new IllegalStateException("Managed admission registration failed");

    ServerLoginConnectionEvents.QUERY_START.register(
        (handler, server, sender, synchronizer) -> {
          // The independent gate is installed even on failure. Fabric removes the query's
          // channel before invoking its receiver; disconnect alone must not open tickVerify.
          CompletableFuture<Void> gate = new CompletableFuture<>();
          synchronizer.waitFor(gate);
          ClientConnection connection =
              ((ServerLoginNetworkHandlerAccessor) handler).getConnection();
          Attempt attempt = null;
          synchronized (lock) {
            reapClosed();
            if (!stopping
                && connection.isOpen()
                && attempts.size() < MAX_PENDING
                && !attempts.containsKey(connection)) {
              try {
                Session session = readServerSession();
                byte[] nonce = new byte[NONCE_BYTES];
                RANDOM.nextBytes(nonce);
                attempt = new Attempt(connection, server, session, nonce, gate);
                attempts.put(connection, attempt);
              } catch (IOException ignored) {
                // Missing, malformed, or rotating configuration never opens admission.
              }
            }
          }
          if (attempt == null) {
            disconnect(connection);
            return;
          }
          PacketByteBuf query = PacketByteBufs.create();
          query.writeByte(VERSION);
          query.writeBytes(attempt.nonce);
          try {
            sender.sendPacket(CHANNEL, query);
          } catch (RuntimeException ignored) {
            reject(connection);
          }
        });

    ServerPlayConnectionEvents.JOIN.register(
        (handler, sender, server) -> {
          synchronized (lock) {
            if (owner != null
                && owner.server == server
                && !owner.rejected
                && owner.connection.getPacketListener() == handler) {
              owner.joined = true;
            }
          }
        });

    ServerLifecycleEvents.SERVER_STARTING.register(
        server -> {
          synchronized (lock) {
            stopping = false;
            nextRotationCheck = System.nanoTime();
            // Independent of game ticks: pause/stalls cannot extend proof/pre-play
            // reservations. This worker touches only admission and transport state.
            timer =
                Executors.newSingleThreadScheduledExecutor(
                    task -> {
                      Thread thread = new Thread(task, "gameharness-admission");
                      thread.setDaemon(true);
                      return thread;
                    });
            timer.scheduleWithFixedDelay(this::maintain, 250, 250, TimeUnit.MILLISECONDS);
          }
        });
    ServerLifecycleEvents.SERVER_STOPPING.register(
        server -> {
          ArrayList<ClientConnection> closing = new ArrayList<>();
          synchronized (lock) {
            stopping = true;
            for (Attempt attempt : attempts.values()) {
              if (attempt.server == server) {
                attempt.rejected = true;
                closing.add(attempt.connection);
              }
            }
          }
          for (ClientConnection connection : closing) disconnect(connection);
        });
    ServerLifecycleEvents.SERVER_STOPPED.register(
        server -> {
          synchronized (lock) {
            if (timer != null) {
              timer.shutdownNow();
              timer = null;
            }
            reapClosed();
          }
        });
  }

  private void receive(ClientConnection connection, boolean understood, PacketByteBuf buf) {
    boolean accepted = false;
    synchronized (lock) {
      reapClosed();
      Attempt attempt = attempts.get(connection);
      if (!stopping && attempt != null && !attempt.rejected && !attempt.responded) {
        attempt.responded = true;
        if (understood
            && buf.readableBytes() == WIRE_BYTES
            && buf.readUnsignedByte() == VERSION
            && System.nanoTime() - attempt.deadline < 0
            && connection.isOpen()) {
          byte[] supplied = new byte[NONCE_BYTES];
          buf.readBytes(supplied);
          try {
            // Re-read immediately before reservation, not just when issuing the nonce.
            Session current = readServerSession();
            try {
              if (attempt.session.same(current)) {
                byte[] expected = proof(current, attempt.nonce);
                try {
                  if (MessageDigest.isEqual(expected, supplied) && owner == null) {
                    owner = attempt;
                    attempt.deadline = System.nanoTime() + JOIN_TIMEOUT;
                    accepted = true;
                    // Ownership is reserved before the only successful gate completion.
                    attempt.gate.complete(null);
                  }
                } finally {
                  Arrays.fill(expected, (byte) 0);
                }
              }
            } finally {
              current.clear();
            }
          } catch (IOException | GeneralSecurityException ignored) {
            // Never expose configuration, proof bytes, or crypto error details.
          } finally {
            Arrays.fill(supplied, (byte) 0);
          }
        }
        if (!accepted) attempt.rejected = true;
      }
    }
    if (!accepted) disconnect(connection);
  }

  private void reject(ClientConnection connection) {
    synchronized (lock) {
      Attempt attempt = attempts.get(connection);
      if (attempt != null) attempt.rejected = true;
    }
    disconnect(connection);
  }

  private void maintain() {
    ArrayList<ClientConnection> closing = new ArrayList<>();
    synchronized (lock) {
      reapClosed();
      if (attempts.isEmpty()) return;
      long now = System.nanoTime();
      boolean checkRotation = now - nextRotationCheck >= 0;
      Session current = null;
      if (checkRotation) {
        nextRotationCheck = now + ROTATION_INTERVAL;
        try {
          current = readServerSession();
        } catch (IOException ignored) {
          // A removed or invalid configuration revokes existing authority too.
        }
      }
      try {
        for (Attempt attempt : attempts.values()) {
          if ((!attempt.joined && now - attempt.deadline >= 0)
              || (checkRotation && (current == null || !attempt.session.same(current)))) {
            attempt.rejected = true;
          }
          if (attempt.rejected) closing.add(attempt.connection);
        }
      } finally {
        if (current != null) current.clear();
      }
    }
    for (ClientConnection connection : closing) disconnect(connection);
  }

  private void reapClosed() {
    Iterator<Attempt> iterator = attempts.values().iterator();
    while (iterator.hasNext()) {
      Attempt attempt = iterator.next();
      if (!attempt.connection.isOpen()) {
        // Not a login/config/play handler event: only actual transport closure releases
        // the reservation, including failed login and configuration transitions.
        if (owner == attempt) owner = null;
        attempt.session.clear();
        Arrays.fill(attempt.nonce, (byte) 0);
        iterator.remove();
        // A rejected gate stays incomplete. Cancellation/exceptional completion is
        // treated as done by Fabric and would accidentally permit tickVerify.
      }
    }
  }

  private static void disconnect(ClientConnection connection) {
    connection.disconnect(DENIED);
  }

  private static Session readServerSession() throws IOException {
    String location = System.getenv("GAMEHARNESS_SESSION_FILE");
    if (location == null || location.isBlank()) throw unavailable();
    return readSession(location);
  }

  static Session readSession(String location) throws IOException {
    byte[] bytes = null;
    try {
      if (location == null || location.isBlank()) throw unavailable();
      try (InputStream stream = Files.newInputStream(Path.of(location))) {
        bytes = stream.readNBytes(16_385);
      }
      if (bytes.length == 0 || bytes.length > 16_384) throw unavailable();
      JsonObject json =
          JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
      String secret = string(json, "secret");
      String world = string(json, "world_id");
      String session = string(json, "session_id");
      JsonElement epochElement = json.get("epoch");
      if (epochElement == null
          || !epochElement.isJsonPrimitive()
          || !epochElement.getAsJsonPrimitive().isNumber()) throw unavailable();
      long epoch = epochElement.getAsBigDecimal().longValueExact();
      if (epoch < 0
          || epoch > 9_007_199_254_740_991L
          || !secret.matches("[0-9a-fA-F]{64}")
          || world.isEmpty()
          || world.length() > 256) throw unavailable();
      UUID sessionId = UUID.fromString(session);
      if (!sessionId.toString().equalsIgnoreCase(session)) throw unavailable();
      byte[] worldBytes = world.getBytes(StandardCharsets.UTF_8);
      if (worldBytes.length > 1024) throw unavailable();
      return new Session(HexFormat.of().parseHex(secret), worldBytes, epoch, sessionId);
    } catch (RuntimeException | IOException ignored) {
      throw unavailable();
    } finally {
      if (bytes != null) Arrays.fill(bytes, (byte) 0);
    }
  }

  private static String string(JsonObject json, String name) throws IOException {
    JsonElement value = json.get(name);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
      throw unavailable();
    return value.getAsString();
  }

  private static IOException unavailable() {
    return new IOException("Managed session configuration unavailable");
  }

  static byte[] proof(Session session, byte[] nonce) throws GeneralSecurityException {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(session.secret, "HmacSHA256"));
    mac.update(DOMAIN);
    mac.update(nonce);
    ByteBuffer binding = ByteBuffer.allocate(28 + session.world.length);
    binding
        .putInt(session.world.length)
        .put(session.world)
        .putLong(session.epoch)
        .putLong(session.sessionId.getMostSignificantBits())
        .putLong(session.sessionId.getLeastSignificantBits());
    mac.update(binding.array());
    return mac.doFinal();
  }

  static final class Session {
    private final byte[] secret;
    private final byte[] world;
    private final long epoch;
    private final UUID sessionId;

    private Session(byte[] secret, byte[] world, long epoch, UUID sessionId) {
      this.secret = secret;
      this.world = world;
      this.epoch = epoch;
      this.sessionId = sessionId;
    }

    private boolean same(Session other) {
      return MessageDigest.isEqual(secret, other.secret)
          && Arrays.equals(world, other.world)
          && epoch == other.epoch
          && sessionId.equals(other.sessionId);
    }

    void clear() {
      Arrays.fill(secret, (byte) 0);
    }
  }

  private static final class Attempt {
    final ClientConnection connection;
    final MinecraftServer server;
    final Session session;
    final byte[] nonce;
    final CompletableFuture<Void> gate;
    long deadline = System.nanoTime() + PROOF_TIMEOUT;
    boolean responded;
    boolean joined;
    boolean rejected;

    Attempt(
        ClientConnection connection,
        MinecraftServer server,
        Session session,
        byte[] nonce,
        CompletableFuture<Void> gate) {
      this.connection = connection;
      this.server = server;
      this.session = session;
      this.nonce = nonce;
      this.gate = gate;
    }
  }
}
