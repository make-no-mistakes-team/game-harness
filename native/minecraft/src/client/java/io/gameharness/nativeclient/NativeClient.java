package io.gameharness.nativeclient;

import com.google.gson.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.DeathScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.ItemEntity;
import net.minecraft.item.BlockItem;
import net.minecraft.item.ItemPlacementContext;
import net.minecraft.item.ItemStack;
import net.minecraft.network.packet.Packet;
import net.minecraft.network.packet.c2s.play.ClickSlotC2SPacket;
import net.minecraft.network.packet.c2s.play.PlayerActionC2SPacket;
import net.minecraft.network.packet.c2s.play.PlayerInteractBlockC2SPacket;
import net.minecraft.registry.Registries;
import net.minecraft.util.Hand;
import net.minecraft.util.ActionResult;
import net.minecraft.util.hit.*;
import net.minecraft.util.math.*;
import net.minecraft.world.RaycastContext;

public final class NativeClient implements ClientModInitializer {
  public static NativeClient INSTANCE;
  public static long blockedKeyboardCallbacks, blockedMouseCallbacks, suppressedPolls;
  private int receiptNonce;
  private final Map<Integer, Long> pendingObservations = new LinkedHashMap<>();
  private final PlayerLifecycle lifecycle = new PlayerLifecycle();
  private long deathNotified = -1;
  private JsonObject death;
  private boolean lifeWasAlive;
  private boolean lastPublishedCanRespawn;
  private long respawnRequest;
  private int respawnReceipt;
  private long respawnAdmissionDeadline;
  private long respawnAdmittedNanos, respawnEmittedNanos;
  private boolean issuingRespawn;
  private CameraMotion.Profile motorProfile = CameraMotion.Profile.BALANCED;
  private EffectAuthority effectAuthority;
  private ClientIncarnationSignals incarnationSignals;
  private JsonObject descriptor;
  private String compatibilityHash;
  private final Map<Long, NativeEffectContract.Received> effectRequests = new HashMap<>();
  private final TargetIncarnations<BlockPos> blockIncarnations = new TargetIncarnations<>(256);
  private final TargetIncarnations<UUID> entityIncarnations = new TargetIncarnations<>(256);
  private final ScreenIncarnations screenIncarnations = new ScreenIncarnations();

  private int nextReceiptNonce() {
    if (receiptNonce == Integer.MAX_VALUE) throw new IllegalStateException("Native receipt nonce range exhausted");
    return ++receiptNonce;
  }

  private void fenceAuthority() {
    effectAuthority.emergencyStop();
    authority = effectAuthority.cancellationGeneration();
  }

  private void bindScopeIfReady() {
    if (!effectAuthority.ready() && incarnationSignals.space() != null && lifecycle.status() != PlayerLifecycle.Status.LOADING) {
      effectAuthority.bind(compatibilityHash, lifecycle.lifeId(), incarnationSignals.space(), incarnationSignals.screen());
    }
  }

  private synchronized void publishScope() {
    if (!connected) return;
    JsonObject notice = new JsonObject(), message = new JsonObject();
    notice.addProperty("type", "scope");
    for (String key : List.of("world_id", "epoch", "session_id")) notice.add(key, config.get(key));
    notice.addProperty("native_boot_id", effectAuthority.nativeBootId());
    notice.addProperty("generation", authority);
    notice.add("life", life());
    notice.add("space", incarnationSignals.space() == null ? JsonNull.INSTANCE : NativeEffectContract.space(incarnationSignals.space()));
    notice.add("screen", NativeEffectContract.screen(incarnationSignals.screen()));
    notice.addProperty("neutralized", motor == null);
    message.add("notice", notice);
    try { output.write(message.toString()); output.newLine(); output.flush(); }
    catch (IOException error) { connected = false; fenceAuthority(); neutralize(); client.scheduleStop(); }
  }

  public void spaceReceived() { incarnationSignals.authoritativeSpaceReceived(); }
  public void scopeUnavailable() { if (incarnationSignals != null) incarnationSignals.loading(); }
  public void screenReceived() { if (incarnationSignals != null) incarnationSignals.viewReceived(); }
  public void screenTransactionReceived() { if (incarnationSignals != null) incarnationSignals.relevantTransactionReceived(); }
  public void screenTransactionReceived(int syncId) {
    if (client.player != null && (syncId <= 0 || syncId == client.player.currentScreenHandler.syncId)) screenTransactionReceived();
  }
  public void entityReplaced(Entity entity) { if (incarnationSignals != null) incarnationSignals.entityReplaced(entity); }

  private NativeEffectContract.Received receivedEffect(long id) {
    synchronized (effectRequests) { return effectRequests.get(id); }
  }

  private static JsonObject rejectedEffect(String stage, String reason) {
    JsonObject result = new JsonObject(), evidence = new JsonObject();
    result.addProperty("status", "failed"); result.addProperty("summary", "Native effect rejected before application: " + reason);
    evidence.addProperty("effect_confirmed", false); evidence.addProperty("world_effect_emitted", false);
    evidence.addProperty("neutralized_effect", false); evidence.addProperty("scope_rejection_stage", stage);
    evidence.addProperty("scope_rejection_reason", reason);
    result.add("evidence", evidence); return result;
  }

  public void inventoryReceipt(int nonce, long generation, String contents) {
    if (generation != authority || client.player == null || client.world == null) return;
    if (nonce != respawnReceipt && !pendingObservations.containsKey(nonce)
        && (motor == null || generation != motor.generation || nonce != motor.receiptNonce)) return;
    JsonObject value = JsonParser.parseString(contents).getAsJsonObject();
    if (value.getAsJsonObject("counts").size() > 64 || value.getAsJsonObject("slots").size() > 64)
      return;
    boolean alive = value.get("alive").getAsBoolean() && value.get("health").getAsFloat() > 0;
    if (nonce == respawnReceipt && lifecycle.status() == PlayerLifecycle.Status.RESPAWNING) {
      respawnReceipt = 0;
      if (!alive) {
        handleLifecycle(false, true);
        return;
      }
      if (lifecycle.confirmRespawn(alive && !client.player.isDead())) {
        long id = respawnRequest;
        respawnRequest = 0;
        blocks.clear();
        entities.clear();
        death = null;
        lifeWasAlive = true;
        incarnationSignals.authoritativeLifeChanged(lifecycle.lifeId());
        publishLife();
        if (id != 0) {
          JsonObject outcome = respawnResult("succeeded", "Vanilla respawn confirmed by new-player server health and inventory receipt", true);
          outcome.getAsJsonObject("evidence").add("life", life());
          reply(id, outcome, null);
        }
      }
      return;
    }
    PlayerLifecycle.Decision decision =
        handleLifecycle(alive && client.player.getHealth() > 0 && !client.player.isDead(), true);
    if (decision == PlayerLifecycle.Decision.WAIT && lifecycle.status() == PlayerLifecycle.Status.LOADING) {
      Long waiting = pendingObservations.remove(nonce);
      if (waiting != null)
        reply(waiting, null, "Waiting for authoritative player state");
      return;
    }
    Long observationId = pendingObservations.remove(nonce);
    if (observationId != null) {
      JsonObject observation = observe();
      JsonArray inventory = new JsonArray();
      for (var entry : value.getAsJsonObject("slots").entrySet()) {
        int slot = Integer.parseInt(entry.getKey());
        if (slot < 0 || slot >= client.player.getInventory().size()) continue;
        JsonObject source = entry.getValue().getAsJsonObject(), item = new JsonObject();
        String name = source.get("name").getAsString();
        item.addProperty("name", name);
        item.addProperty("slot", slot);
        item.addProperty("count", source.get("count").getAsInt());
        item.addProperty(
            "display_name",
            Registries.ITEM
                .get(net.minecraft.util.Identifier.ofVanilla(name))
                .getName()
                .getString());
        inventory.add(item);
      }
      observation.getAsJsonObject("data").getAsJsonObject("player").add("inventory", inventory);
      observation.getAsJsonObject("data").getAsJsonObject("player").add("health", value.get("health"));
      reply(observationId, observation, null);
      return;
    }
    if (motor == null || generation != motor.generation || nonce != motor.receiptNonce) return;
    if (!motor.ready) {
      if (!motor.authorized(true)) {
        motor.rejectApplication("game_thread_baseline");
        return;
      }
      motor.inventoryBefore = value.getAsJsonObject("counts");
      motor.receiptNonce = 0;
      motor.ready = true;
      motor.started = System.nanoTime();
      long latency = motor.started - motor.receivedNanos;
      motorDispatchCount++;
      motorDispatchNanos += latency;
      motorDispatchMaxNanos = Math.max(motorDispatchMaxNanos, latency);
      motor.start();
    } else {
      if (motor.completingMove && System.nanoTime() >= motor.moveReceiptDeadline) {
        motor.finish(
            "unknown",
            "Movement completed, but its authoritative inventory receipt arrived after the deadline",
            false);
        return;
      }
      motor.serverInventoryAfter = value;
      if (motor.completingPickup) {
        boolean timely = System.nanoTime() < motor.pickupReceiptDeadline;
        boolean gained = timely && motor.serverCount(motor.pickupItem) > motor.beforeCount(motor.pickupItem);
        motor.finish(gained ? "succeeded" : "unknown",
            gained ? "Selected drop disappeared nearby; own item gain confirmed by server inventory"
                : "Selected drop disappeared; own pickup was not confirmed within its receipt bound",
            gained);
      } else if (motor.completingMove)
        motor.finish(
            "succeeded",
            "Movement interval completed; own inventory snapshot confirmed",
            motor.completedMovementEffect);
    }
  }

  private final MinecraftClient client = MinecraftClient.getInstance();
  private final VoxelVisibility visibility = new VoxelVisibility();
  private final BlockPos.Mutable visibilityCell = new BlockPos.Mutable();
  private final VoxelVisibility.Cells cells =
      (x, y, z) -> {
        visibilityCell.set(x, y, z);
        if (client.world == null || !client.world.isChunkLoaded(visibilityCell)) return -1;
        return client.world.getBlockState(visibilityCell).isAir() ? 0 : 1;
      };

  private boolean clearLine(Vec3d end, BlockPos exempt) {
    Vec3d eye = client.player.getEyePos();
    return visibility.clear(
        eye.x,
        eye.y,
        eye.z,
        end.x,
        end.y,
        end.z,
        exempt == null ? Integer.MIN_VALUE : exempt.getX(),
        exempt == null ? Integer.MIN_VALUE : exempt.getY(),
        exempt == null ? Integer.MIN_VALUE : exempt.getZ(),
        cells);
  }

  private boolean authorizedEntity(Entity e) {
    return e != null
        && !e.isRemoved()
        && !e.isInvisibleTo(client.player)
        && client.player.canSee(e)
        && e.squaredDistanceTo(client.player) <= NativeContractResource.RADIUS_SQUARED
        && clearLine(e.getBoundingBox().getCenter(), null);
  }

  private JsonObject config;
  private BufferedWriter output;
  private volatile boolean connected;
  private volatile long authority = 1;
  private long lastRequestId;
  private final java.util.concurrent.atomic.AtomicInteger queued =
      new java.util.concurrent.atomic.AtomicInteger();
  private Motor motor;
  private Video video;
  private long observationSeq;
  private long observationNanos,
      observationCount,
      observationMaxNanos,
      motorTickNanos,
      motorTickCount,
      motorTickMaxNanos,
      dispatchQueueNanos,
      dispatchQueueCount,
      dispatchQueueMaxNanos;
  private long motorDispatchNanos, motorDispatchCount, motorDispatchMaxNanos;

  public void blockUpdated(BlockPos pos) {
    blockIncarnations.replaced(pos);
    if (motor != null
        && motor.confirmationPosition != null
        && motor.confirmationPosition.equals(pos)) {
      motor.blockConfirmed = true;
      motor.serverBlockRemoved = motor.sentSequence >= 0
          && client.world != null && client.world.getBlockState(pos).isAir();
    }
  }

  public void sent(Packet<?> packet) {
    if (motor != null && motor.kind.equals("place") && packet instanceof ClickSlotC2SPacket) {
      motor.equipmentEffectEmitted = true;
      motor.emissions |= EffectOutcome.WORLD_EFFECT;
    }
    if (motor == null || motor.target == null) return;
    int sequence = -1;
    if (packet instanceof PlayerActionC2SPacket p && p.getPos().equals(motor.target))
      sequence = p.getSequence();
    if (packet instanceof PlayerInteractBlockC2SPacket p
        && p.getBlockHitResult().getBlockPos().equals(motor.target)) {
      sequence = p.getSequence();
      if (motor.kind.equals("place")) motor.placementEffectEmitted = true;
    }
    if (sequence >= 0) {
      motor.emissions |= EffectOutcome.WORLD_EFFECT;
      motor.sentSequence = sequence;
      motor.blockConfirmed = false;
      motor.serverBlockRemoved = false;
    }
  }

  public void actionAcknowledged(int sequence) {
    if (motor != null && motor.sentSequence >= 0 && sequence >= motor.sentSequence)
      motor.blockConfirmed = true;
  }

  private final Map<String, BlockPos> blocks = new HashMap<>();
  private final Map<String, Entity> entities = new HashMap<>();
  private final SoundProjection sounds = new SoundProjection();
  private static final String[]
      SOUND_CATEGORIES = {"movement", "interaction", "combat", "creature", "weather"},
      SOUND_DIRECTIONS = {"here", "N", "NE", "E", "SE", "S", "SW", "W", "NW"},
      SOUND_BANDS = {"near", "mid", "far"};

  public void soundDelivered(int category, double dx, double dy, double dz, long at) {
    if (connected) sounds.accept(category, dx, dy, dz, at);
  }

  public void attackReceipt(int nonce, long generation, int outcome) {
    if (motor != null
        && generation == authority
        && generation == motor.generation
        && motor.attackNonce == nonce
        && motor.kind.equals("attack")
        && outcome >= 0
        && outcome <= 2) motor.damageOutcome = outcome;
  }

  public static boolean managed() {
    return System.getProperty("gameharness.session") != null;
  }

  public static String hello(JsonObject config) {
    return NativeEffectContract.hello(config, INSTANCE.descriptor, INSTANCE.effectAuthority.nativeBootId()).toString();
  }

  public void onInitializeClient() {
    if (!managed()) throw new IllegalStateException("GameHarness requires its private launcher");
    INSTANCE = this;
    try {
      config =
          JsonParser.parseString(
                  Files.readString(Path.of(System.getProperty("gameharness.session"))))
              .getAsJsonObject();
      if (config.has("motor_profile"))
        motorProfile = CameraMotion.Profile.valueOf(config.get("motor_profile").getAsString().toUpperCase(Locale.ROOT));
      effectAuthority = new EffectAuthority(NativeEffectContract.id(config, "session_id"),
          NativeEffectContract.id(config, "world_id"), NativeEffectContract.counter(config, "epoch"));
      descriptor = NativeContractResource.descriptor(motorProfile.name().toLowerCase(Locale.ROOT));
      compatibilityHash = NativeContractResource.hash(descriptor);
      incarnationSignals = new ClientIncarnationSignals(client, effectAuthority, blockIncarnations, entityIncarnations, screenIncarnations,
          new ClientIncarnationSignals.Listener() {
            public void scopeFenced() {
              authority = effectAuthority.cancellationGeneration();
              if (respawnRequest != 0 && lifecycle.status() == PlayerLifecycle.Status.RESPAWNING) {
                blocks.clear(); entities.clear(); rejectObservations("Observation predates replacement space"); applyInput();
              } else neutralize();
              bindScopeIfReady(); publishScope();
            }
            public void screenChanged() { publishScope(); }
          });
    } catch (Exception e) {
      throw new IllegalStateException("Private native configuration unavailable");
    }
    AdmissionClient.install();
    InventoryProofClient.install();
    AttackProofClient.install();
    ClientTickEvents.START_CLIENT_TICK.register(c -> tick());
    video = new Video(config);
    Thread control = new Thread(this::control, "gameharness-control");
    control.setDaemon(true);
    control.start();
  }

  public void render() {
    if (motor != null) motor.rotate();
    if (video != null) video.capture();
  }

  private void control() {
    try (Socket socket =
        new Socket(InetAddress.getLoopbackAddress(), config.get("control_port").getAsInt())) {
      socket.setTcpNoDelay(true);
      socket.setSoTimeout(15000);
      output =
          new BufferedWriter(
              new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
      output.write(hello(config));
      output.newLine();
      output.flush();
      connected = true;
      InputStream in = socket.getInputStream();
      ByteArrayOutputStream line = new ByteArrayOutputStream();
      int b;
      while ((b = in.read()) != -1) {
        if (b == 10) {
          JsonObject request =
              JsonParser.parseString(line.toString(StandardCharsets.UTF_8)).getAsJsonObject();
          line.reset();
          long requestId = NativeEffectContract.counter(request, "id");
          if (requestId <= lastRequestId || queued.incrementAndGet() > 32)
            throw new IOException("Invalid request sequence or pending bound");
          lastRequestId = requestId;
          if (!request.get("session_id").getAsString().equals(config.get("session_id").getAsString())
              || !request.get("world_id").getAsString().equals(config.get("world_id").getAsString())
              || NativeEffectContract.counter(request, "epoch") != NativeEffectContract.counter(config, "epoch")
              || !NativeEffectContract.id(request, "native_boot_id").equals(effectAuthority.nativeBootId()))
            throw new IOException("Authority mismatch");
          long generation = NativeEffectContract.counter(request, "generation");
          request.addProperty("received_ns", System.nanoTime());
          String method = request.get("method").getAsString();
          if (method.equals("cancel") || method.equals("disconnect")) {
            JsonObject params = request.getAsJsonObject("params");
            boolean emergency = method.equals("disconnect") || params.has("emergency") && params.get("emergency").getAsBoolean();
            boolean matched;
            if (emergency) { fenceAuthority(); matched = true; }
            else {
              matched = effectAuthority.close(NativeEffectContract.owner(params.getAsJsonObject("expected_owner")));
              authority = effectAuthority.cancellationGeneration();
            }
            request.addProperty("matched_owner", matched);
          } else if (method.equals("execute")) {
            NativeEffectContract.Received received = NativeEffectContract.effect(request.getAsJsonObject("params"), generation);
            EffectAuthority.Rejection rejection = effectAuthority.grant(received.owner(), received.compatibilityHash(), received.expectedScreen());
            if (rejection != EffectAuthority.Rejection.NONE) {
              queued.decrementAndGet();
              reply(requestId, NativeEffectContract.receipt(received, rejectedEffect("receive", rejection.name())), null);
              continue;
            }
            synchronized (effectRequests) { effectRequests.put(requestId, received); }
          }
          client.execute(
              () -> {
                try {
                  dispatch(request);
                } finally {
                  queued.decrementAndGet();
                }
              });
        } else {
          if (line.size() >= 65536) throw new IOException("Control frame exceeded bound");
          line.write(b);
        }
      }
    } catch (Exception ignored) {
    } finally {
      connected = false;
      fenceAuthority();
      client.execute(
          () -> {
            neutralize();
            client.scheduleStop();
          });
    }
  }

  private synchronized void reply(long id, JsonElement data, String error) {
    if (!connected) return;
    JsonObject response = new JsonObject();
    response.addProperty("id", id);
    response.addProperty("ok", error == null);
    NativeEffectContract.Received received;
    synchronized (effectRequests) { received = effectRequests.remove(id); }
    if (received != null) effectAuthority.complete(received.owner());
    if (error == null) response.add("data", received == null ? data : NativeEffectContract.receipt(received, data.getAsJsonObject()));
    else response.addProperty("error", error);
    try {
      output.write(response.toString());
      output.newLine();
      output.flush();
    } catch (IOException e) {
      connected = false;
      fenceAuthority();
      neutralize();
      client.scheduleStop();
    }
  }

  public void healthUpdated(float health) {
    if (!connected || client.player == null || client.world == null) return;
    handleLifecycle(health > 0 && !client.player.isDead(), true);
    if (lifecycle.status() == PlayerLifecycle.Status.RESPAWNING && respawnReceipt == 0) {
      respawnReceipt = nextReceiptNonce();
      InventoryProofClient.request(respawnReceipt, authority);
    }
  }

  public void playerRespawned() {
    lifecycle.playerReplaced();
    spaceReceived();
    if (lifecycle.status() == PlayerLifecycle.Status.RESPAWNING) {
      respawnReceipt = 0;
      rejectObservations("Observation predates the replacement player");
    }
  }

  public void playerPositionReceived() {
    lifecycle.positionReceived();
    spaceReceived();
    if (client.player != null)
      handleLifecycle(client.player.getHealth() > 0 && !client.player.isDead(), false);
    if (lifecycle.status() == PlayerLifecycle.Status.RESPAWNING && respawnReceipt == 0) {
      respawnReceipt = nextReceiptNonce();
      InventoryProofClient.request(respawnReceipt, authority);
    }
  }

  private boolean canRespawn() {
    return lifecycle.status() == PlayerLifecycle.Status.DEAD
        && client.currentScreen instanceof DeathScreen screen
        && ((io.gameharness.nativeclient.mixin.DeathScreenAccess) screen).gameharness$deathTicks() >= 20
        && !((io.gameharness.nativeclient.mixin.DeathScreenAccess) screen).gameharness$hardcore();
  }

  private void requestRespawnWhenReady() {
    if (respawnRequest == 0 || lifecycle.status() != PlayerLifecycle.Status.DEAD) return;
    long now = System.nanoTime() / 1000000;
    if (now >= respawnAdmissionDeadline) {
      long id = respawnRequest;
      respawnRequest = 0;
      reply(id, respawnResult("failed", "Vanilla death screen did not become respawn-ready before the admission deadline", false), null);
      return;
    }
    if (!lifecycle.beginRespawn(lifecycle.lifeId(), canRespawn(), now)) return;
    publishLife();
    issuingRespawn = true;
    respawnEmittedNanos = System.nanoTime();
    try {
      client.player.requestRespawn();
    } finally {
      issuingRespawn = false;
    }
  }

  public boolean respawnAuthorized() { return issuingRespawn; }

  private JsonObject respawnResult(String status, String summary, boolean effect) {
    JsonObject outcome = result(status, summary, effect);
    JsonObject evidence = outcome.getAsJsonObject("evidence");
    long now = System.nanoTime();
    evidence.addProperty("respawn_request_emitted", respawnEmittedNanos != 0);
    evidence.addProperty("native_respawn_readiness_wait_ms",
        ((respawnEmittedNanos == 0 ? now : respawnEmittedNanos) - respawnAdmittedNanos) / 1e6);
    evidence.addProperty("native_life_recovery_ms",
        respawnEmittedNanos == 0 ? 0 : (now - respawnEmittedNanos) / 1e6);
    return outcome;
  }

  private JsonObject life() {
    JsonObject value = new JsonObject();
    value.addProperty("life_id", lifecycle.lifeId());
    value.addProperty("status", lifecycle.status().name().toLowerCase(Locale.ROOT));
    value.addProperty("can_respawn", canRespawn());
    value.add("death", death == null ? JsonNull.INSTANCE : death);
    return value;
  }

  private synchronized void publishLife() {
    if (!connected) return;
    JsonObject message = new JsonObject(), notice = new JsonObject();
    notice.addProperty("type", "life");
    for (String key : List.of("world_id", "epoch", "session_id")) notice.add(key, config.get(key));
    notice.addProperty("generation", authority);
    notice.addProperty("native_boot_id", effectAuthority.nativeBootId());
    notice.add("space", incarnationSignals.space() == null ? JsonNull.INSTANCE : NativeEffectContract.space(incarnationSignals.space()));
    notice.add("screen", NativeEffectContract.screen(incarnationSignals.screen()));
    notice.addProperty("neutralized", true);
    JsonObject publishedLife = life();
    notice.add("life", publishedLife);
    message.add("notice", notice);
    try {
      output.write(message.toString());
      output.newLine();
      output.flush();
      lastPublishedCanRespawn = publishedLife.get("can_respawn").getAsBoolean();
    } catch (IOException error) {
      connected = false;
      fenceAuthority();
      neutralize();
      client.scheduleStop();
    }
  }

  private PlayerLifecycle.Decision handleLifecycle(boolean alive, boolean authoritative) {
    long previousLife = lifecycle.lifeId();
    boolean replacing = lifecycle.status() == PlayerLifecycle.Status.RESPAWNING;
    PlayerLifecycle.Decision decision =
        lifecycle.update(alive, authoritative, System.nanoTime() / 1000000);
    bindScopeIfReady();
    if (decision == PlayerLifecycle.Decision.READY) lifeWasAlive = true;
    if (decision == PlayerLifecycle.Decision.DIED) {
      if (replacing && lifecycle.lifeId() != previousLife) lifeWasAlive = true;
      fenceDeath();
    } else if (decision == PlayerLifecycle.Decision.RESPAWN_FAILED) {
      long id = respawnRequest;
      respawnRequest = 0; respawnReceipt = 0;
      publishLife();
      if (id != 0) reply(id, respawnResult("unknown", "Vanilla respawn outcome was not confirmed before its deadline; it will not be replayed", false), null);
    }
    return decision;
  }

  private synchronized void fenceDeath() {
    if (deathNotified == lifecycle.lifeId()) return;
    deathNotified = lifecycle.lifeId();
    effectAuthority.lifeChanged(lifecycle.lifeId());
    authority = effectAuthority.cancellationGeneration();
    // Fence locally before publishing the authoritative cause. It must precede generic action loss.
    applyInput();
    sounds.clear();
    if (client.interactionManager != null) client.interactionManager.cancelBlockBreaking();
    if (client.player != null) client.player.stopUsingItem();
    blocks.clear();
    entities.clear();
    blockIncarnations.invalidate(); entityIncarnations.invalidate();
    death = null;
    if (lifeWasAlive) {
      death = new JsonObject();
      death.addProperty("death_id", UUID.randomUUID().toString());
      death.addProperty("at", Instant.now().toString());
      death.add("message", JsonNull.INSTANCE);
    }
    lifeWasAlive = false;
    publishLife();
    if (motor != null)
      motor.finish(
          EffectOutcome.deadline(motor.emissions), "Player died while the action was active", false);
    neutralize();
  }

  private void dispatch(JsonObject request) {
    long id = NativeEffectContract.counter(request, "id");
    try {
      long queued = System.nanoTime() - request.get("received_ns").getAsLong();
      dispatchQueueNanos += queued;
      dispatchQueueCount++;
      dispatchQueueMaxNanos = Math.max(dispatchQueueMaxNanos, queued);
      String method = request.get("method").getAsString();
      if (method.equals("cancel")) {
        boolean matched = request.get("matched_owner").getAsBoolean();
        if (matched) neutralize();
        JsonObject result = new JsonObject();
        result.addProperty("neutralized", true);
        result.addProperty("matched_owner", matched);
        result.addProperty("generation", authority);
        result.add("session_id", config.get("session_id"));
        result.addProperty("life_id", lifecycle.lifeId());
        reply(id, result, null);
        return;
      }
      if (method.equals("disconnect")) {
        neutralize();
        reply(id, new JsonObject(), null);
        client.scheduleStop();
        return;
      }
      if (method.equals("ping")) {
        reply(id, new JsonObject(), null);
        return;
      }
      if (method.equals("diagnostics")) {
        reply(id, diagnostics(), null);
        return;
      }
      if (method.equals("motor_profile")) {
        if (motor != null || respawnRequest != 0 || effectAuthority.owner() != null) {
          reply(id, null, "Motor profile changes require a quiescent effect owner");
          return;
        }
        motorProfile = CameraMotion.Profile.valueOf(request.getAsJsonObject("params").get("profile").getAsString().toUpperCase(Locale.ROOT));
        descriptor = NativeContractResource.descriptor(motorProfile.name().toLowerCase(Locale.ROOT));
        compatibilityHash = NativeContractResource.hash(descriptor);
        if (effectAuthority.ready()) effectAuthority.bind(compatibilityHash, lifecycle.lifeId(), incarnationSignals.space(), incarnationSignals.screen());
        JsonObject value = new JsonObject();
        value.addProperty("profile", motorProfile.name().toLowerCase(Locale.ROOT));
        value.add("descriptor", descriptor);
        reply(id, value, null);
        return;
      }
      if (client.player == null || client.world == null) {
        reply(id, null, "Minecraft player has not joined");
        return;
      }
      if (method.equals("observe")) {
        if (pendingObservations.size() >= 16) {
          reply(id, null, "Observation receipt bound reached");
          return;
        }
        int nonce = nextReceiptNonce();
        pendingObservations.put(nonce, id);
        InventoryProofClient.request(nonce, authority);
        return;
      }
      if (method.equals("recipes")) {
        reply(
            id,
            Recipes.available(client, request.getAsJsonObject("params").get("item").getAsString()),
            null);
        return;
      }
      if (!method.equals("execute")) {
        reply(id, null, "Unsupported native method");
        return;
      }
      NativeEffectContract.Received received = receivedEffect(id);
      if (received == null) {
        reply(id, null, "Effect request has no authenticated host owner");
        return;
      }
      EffectAuthority.Rejection rejection = effectAuthority.validateApplication(received.owner(), received.compatibilityHash(), received.expectedScreen());
      if (rejection != EffectAuthority.Rejection.NONE) {
        reply(id, rejectedEffect("game_thread", rejection.name()), null);
        return;
      }
      JsonObject action = received.action();
      if (action.get("kind").getAsString().equals("respawn")) {
        if (respawnRequest != 0 || motor != null || lifecycle.status() != PlayerLifecycle.Status.DEAD) {
          reply(id, result("failed", "Vanilla death screen is not ready for this life respawn", false), null);
          return;
        }
        respawnRequest = id;
        respawnAdmittedNanos = System.nanoTime();
        respawnEmittedNanos = 0;
        respawnAdmissionDeadline = System.nanoTime() / 1000000 + 10000;
        requestRespawnWhenReady();
        return;
      }
      if (!lifecycle.ready() || client.player.getHealth() <= 0 || client.player.isDead()) {
        handleLifecycle(client.player.getHealth() > 0 && !client.player.isDead(), false);
        reply(id, result("failed", "Minecraft player is not authoritatively alive and ready", false), null);
        return;
      }
      if (motor != null) {
        reply(id, result("failed", "An effect owner is already active", false), null);
        return;
      }
      if (client.player.isDead()) {
        reply(id, result("failed", "Player is dead", false), null);
        return;
      }
      observe();
      motor =
          new Motor(
              id,
              received,
              authority,
              request.get("received_ns").getAsLong());
      motor.requestInventory();
    } catch (Exception e) {
      reply(id, null, "Native operation rejected: " + e.getClass().getSimpleName());
    }
  }

  private JsonObject diagnostics() {
    JsonObject m = new JsonObject();
    m.add("capture", video.metrics());
    m.add("session_id", config.get("session_id"));
    m.addProperty("native_generation", authority);
    m.add("life", life());
    m.addProperty("motor_profile", motorProfile.name().toLowerCase(Locale.ROOT));
    m.addProperty("screen_type", client.currentScreen == null ? null : client.currentScreen.getClass().getName());
    if (client.player != null) {
      var handler = client.player.currentScreenHandler;
      JsonObject custody = new JsonObject();
      custody.addProperty("sync_id", handler.syncId);
      custody.addProperty("cursor_count", handler.getCursorStack().getCount());
      int size = handler instanceof net.minecraft.screen.CraftingScreenHandler ? 9
          : handler instanceof net.minecraft.screen.PlayerScreenHandler ? 4 : 0;
      int grid = 0;
      for (int i = 1; i <= size; i++) grid += handler.getSlot(i).getStack().getCount();
      custody.addProperty("grid_count", grid);
      m.add("current_inventory_custody", custody);
    }
    m.addProperty("death_screen", client.currentScreen instanceof DeathScreen);
    m.addProperty("respawn_pending", respawnRequest != 0);
    m.addProperty("motor_active", motor != null);
    m.addProperty("motor_world_effect_emitted", motor != null
        && (motor.emissions & EffectOutcome.WORLD_EFFECT) != 0);
    var keys = client.options;
    m.addProperty("controls_neutral", keys == null || !(keys.forwardKey.isPressed()
        || keys.backKey.isPressed() || keys.leftKey.isPressed() || keys.rightKey.isPressed()
        || keys.jumpKey.isPressed() || keys.sprintKey.isPressed() || keys.sneakKey.isPressed()
        || keys.attackKey.isPressed() || keys.useKey.isPressed()));
    m.addProperty("max_yaw_degrees_per_second", motorProfile.yawSpeed);
    m.addProperty("max_pitch_degrees_per_second", motorProfile.pitchSpeed);
    m.addProperty("yaw_acceleration_degrees_per_second_squared", motorProfile.yawAcceleration);
    m.addProperty("pitch_acceleration_degrees_per_second_squared", motorProfile.pitchAcceleration);
    m.addProperty("camera_integration_clock", "render_monotonic");
    if (motor != null) {
      if (motor.inventorySession() != null)
        m.add("native_inventory_ui", motor.inventorySession().diagnostics());
      m.addProperty("yaw_velocity_degrees_per_second", motor.yawVelocity);
      m.addProperty("pitch_velocity_degrees_per_second", motor.pitchVelocity);
      m.addProperty("target_yaw_degrees", motor.yaw);
      m.addProperty("target_pitch_degrees", motor.pitch);
    }
    if (motor != null && motor.kind.equals("navigate")) {
      m.addProperty("route_points", motor.routePoints);
      m.addProperty("route_sample_age_ms", (System.nanoTime() - motor.routeSampled) / 1e6);
      m.addProperty("navigation_forward", motor.navForward);
      m.addProperty("navigation_back", motor.navBack);
      m.addProperty("navigation_left", motor.navLeft);
      m.addProperty("navigation_right", motor.navRight);
      m.addProperty("navigation_world_yaw_degrees", motor.steering.worldYaw);
      m.addProperty("navigation_yaw_error_degrees", motor.steering.yawError);
      JsonObject lookahead = new JsonObject();
      lookahead.addProperty("x", motor.routeGaze.x);
      lookahead.addProperty("y", motor.routeGaze.y);
      lookahead.addProperty("z", motor.routeGaze.z);
      m.add("navigation_lookahead", lookahead);
    }
    m.addProperty("observation_count", observationCount);
    m.addProperty(
        "observation_mean_ms",
        observationCount == 0 ? 0 : observationNanos / 1e6 / observationCount);
    m.addProperty("observation_max_ms", observationMaxNanos / 1e6);
    m.addProperty("motor_tick_count", motorTickCount);
    m.addProperty(
        "motor_tick_mean_ms", motorTickCount == 0 ? 0 : motorTickNanos / 1e6 / motorTickCount);
    m.addProperty("motor_tick_max_ms", motorTickMaxNanos / 1e6);
    m.addProperty(
        "motor_dispatch_mean_ms",
        motorDispatchCount == 0 ? 0 : motorDispatchNanos / 1e6 / motorDispatchCount);
    m.addProperty("motor_dispatch_max_ms", motorDispatchMaxNanos / 1e6);
    m.addProperty(
        "control_queue_mean_ms",
        dispatchQueueCount == 0 ? 0 : dispatchQueueNanos / 1e6 / dispatchQueueCount);
    m.addProperty("control_queue_max_ms", dispatchQueueMaxNanos / 1e6);
    m.addProperty("blocked_keyboard_callbacks", blockedKeyboardCallbacks);
    m.addProperty("blocked_mouse_callbacks", blockedMouseCallbacks);
    if (client.getWindow() != null) {
      long window = client.getWindow().getHandle();
      m.addProperty(
          "owned_window_glfw_forward_pressed",
          org.lwjgl.glfw.GLFW.glfwGetKey(window, org.lwjgl.glfw.GLFW.GLFW_KEY_W)
              == org.lwjgl.glfw.GLFW.GLFW_PRESS);
      m.addProperty(
          "game_forward_poll_pressed",
          net.minecraft.client.util.InputUtil.isKeyPressed(window, org.lwjgl.glfw.GLFW.GLFW_KEY_W));
    }
    m.addProperty("suppressed_keyboard_polls", suppressedPolls);
    m.addProperty(
        "heap_used_bytes", Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory());
    return m;
  }

  private JsonObject player() {
    ClientPlayerEntity p = client.player;
    JsonObject v = new JsonObject();
    v.add("position", position(p.getPos()));
    v.addProperty("yaw", Math.toRadians(MathHelper.wrapDegrees(p.getYaw())));
    v.addProperty("pitch", Math.toRadians(-p.getPitch()));
    v.addProperty("health", p.getHealth());
    v.addProperty("food", p.getHungerManager().getFoodLevel());
    v.addProperty("on_ground", p.isOnGround());
    v.addProperty("in_water", p.isTouchingWater());
    JsonArray inventory = new JsonArray();
    for (int i = 0; i < p.getInventory().size(); i++) {
      ItemStack s = p.getInventory().getStack(i);
      if (s.isEmpty()) continue;
      JsonObject item = new JsonObject();
      item.addProperty("name", Registries.ITEM.getId(s.getItem()).getPath());
      item.addProperty("display_name", s.getName().getString());
      item.addProperty("count", s.getCount());
      item.addProperty("slot", i);
      inventory.add(item);
    }
    v.add("inventory", inventory);
    return v;
  }

  private static JsonObject position(Vec3d p) {
    JsonObject v = new JsonObject();
    v.addProperty("x", p.x);
    v.addProperty("y", p.y);
    v.addProperty("z", p.z);
    return v;
  }

  private JsonObject observe() {
    if (incarnationSignals.space() == null) throw new IllegalStateException("Authoritative player space is unavailable");
    long observationStarted = System.nanoTime();
    JsonObject o = new JsonObject(), data = new JsonObject();
    String now = Instant.now().toString();
    o.addProperty("schema_version", 3);
    o.add("world_id", config.get("world_id"));
    o.add("epoch", config.get("epoch"));
    o.add("session_id", config.get("session_id"));
    o.add("life", life());
    o.addProperty("native_boot_id", effectAuthority.nativeBootId());
    o.add("space", NativeEffectContract.space(incarnationSignals.space()));
    o.add("screen", NativeEffectContract.screen(incarnationSignals.screen()));
    observationSeq = ContractIdentity.next(observationSeq);
    o.addProperty("observation_seq", observationSeq);
    o.addProperty("captured_at", now);
    JsonObject profile = descriptor.getAsJsonObject("observation").getAsJsonObject("profile");
    o.add("profile_id", profile.get("id"));
    o.add("profile_configuration_hash", profile.get("configuration_hash"));
    o.addProperty("compatibility_hash", compatibilityHash);
    o.add("data", data);
    data.add("player", player());
    JsonArray visible = new JsonArray();
    blocks.clear();
    entities.clear();
    BlockPos center = client.player.getBlockPos();
    Vec3d eye = client.player.getEyePos();
    // Resolve geometry first; hidden block material is never inspected before the visibility test.
    outer:
    for (int r = 0; r <= NativeContractResource.RADIUS; r++)
      for (int y = -r; y <= r; y++)
        for (int x = -r; x <= r; x++)
          for (int z = -r; z <= r; z++) {
            if (Math.max(Math.abs(x), Math.max(Math.abs(y), Math.abs(z))) != r
                || x * x + y * y + z * z > NativeContractResource.RADIUS_SQUARED) continue;
            BlockPos pos = center.add(x, y, z);
            if (!clearLine(pos.toCenterPos(), pos)) continue;
            BlockHitResult hit =
                client.world.raycast(
                    new RaycastContext(
                        eye,
                        pos.toCenterPos(),
                        RaycastContext.ShapeType.OUTLINE,
                        RaycastContext.FluidHandling.NONE,
                        client.player));
            if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(pos)) continue;
            TargetIncarnations.Target reference = blockIncarnations.observe(pos, incarnationSignals.space(), lifecycle.lifeId());
            String id = reference.targetId();
            blocks.put(id, pos);
            JsonObject item = new JsonObject();
            item.add("target", NativeEffectContract.target(reference));
            item.addProperty(
                "name",
                Registries.BLOCK.getId(client.world.getBlockState(pos).getBlock()).getPath());
            item.add("position", position(pos.toCenterPos()));
            item.addProperty("observed_at", now);
            item.addProperty("current", true);
            visible.add(item);
            if (visible.size() >= NativeContractResource.MAX_BLOCKS) break outer;
          }
    JsonArray seenEntities = new JsonArray();
    for (Entity e :
        client.world.getOtherEntities(client.player, client.player.getBoundingBox().expand(NativeContractResource.RADIUS))) {
      if (!authorizedEntity(e)) continue;
      TargetIncarnations.Target reference = entityIncarnations.observe(e.getUuid(), incarnationSignals.space(), lifecycle.lifeId());
      String id = reference.targetId();
      entities.put(id, e);
      JsonObject item = new JsonObject();
      item.add("target", NativeEffectContract.target(reference));
      item.addProperty("name", Registries.ENTITY_TYPE.getId(e.getType()).getPath());
      item.add("position", position(e.getPos()));
      item.addProperty("observed_at", now);
      item.addProperty("current", true);
      if (e instanceof ItemEntity dropped && !dropped.getStack().isEmpty())
        item.addProperty("item_name", Registries.ITEM.getId(dropped.getStack().getItem()).getPath());
      seenEntities.add(item);
      if (seenEntities.size() >= NativeContractResource.MAX_ENTITIES) break;
    }
    data.add("blocks", visible);
    data.add("entities", seenEntities);
    JsonArray heard = new JsonArray();
    for (SoundProjection.Group group : sounds.drain(Instant.parse(now).toEpochMilli())) {
      JsonObject sound = new JsonObject();
      sound.addProperty("category", SOUND_CATEGORIES[group.category()]);
      sound.addProperty("direction", SOUND_DIRECTIONS[group.direction()]);
      sound.addProperty("distance", SOUND_BANDS[group.distance()]);
      sound.addProperty("observed_at", now);
      heard.add(sound);
    }
    data.add("sounds", heard);
    JsonObject coverage = new JsonObject();
    coverage.addProperty("partial", true);
    coverage.addProperty("max_age_ms", NativeContractResource.MAX_AGE_MS);
    o.add("freshness", coverage);
    long elapsed = System.nanoTime() - observationStarted;
    observationNanos += elapsed;
    observationMaxNanos = Math.max(observationMaxNanos, elapsed);
    observationCount++;
    return o;
  }

  private JsonObject inventoryCounts() {
    JsonObject counts = new JsonObject();
    for (int i = 0; i < client.player.getInventory().size(); i++) {
      ItemStack stack = client.player.getInventory().getStack(i);
      if (stack.isEmpty()) continue;
      String name = Registries.ITEM.getId(stack.getItem()).getPath();
      counts.addProperty(
          name, (counts.has(name) ? counts.get(name).getAsInt() : 0) + stack.getCount());
    }
    return counts;
  }

  private JsonObject result(String status, String summary, boolean effect) {
    JsonObject r = new JsonObject(), e = new JsonObject();
    r.addProperty("status", status);
    r.addProperty("summary", summary);
    e.addProperty("effect_confirmed", effect);
    e.addProperty("neutralized_effect", false);
    e.addProperty("neutralized", motor == null);
    e.add("session_id", config.get("session_id"));
    e.addProperty("life_id", lifecycle.lifeId());
    if (client.player != null) e.add("player", player());
    r.add("evidence", e);
    return r;
  }

  private void tick() {
    if (!connected) {
      neutralize();
      return;
    }
    if (client.player == null || client.world == null) {
      if (motor != null) motor.finish("failed", "Player unavailable", false);
      neutralize();
      return;
    }
    if (handleLifecycle(client.player.getHealth() > 0 && !client.player.isDead(), false)
        != PlayerLifecycle.Decision.READY) {
      applyInput();
      if (death != null && death.get("message").isJsonNull()
          && client.currentScreen instanceof DeathScreen screen) {
        var text = ((io.gameharness.nativeclient.mixin.DeathScreenAccess) screen).gameharness$deathMessage();
        if (text != null) {
          String message = text.getString();
          death.addProperty("message", message.substring(0, Math.min(1000, message.length())));
        }
      }
      if (lifecycle.status() == PlayerLifecycle.Status.DEAD
          && canRespawn() != lastPublishedCanRespawn)
        publishLife();
      requestRespawnWhenReady();
      if (lifecycle.status() == PlayerLifecycle.Status.RESPAWNING && respawnReceipt == 0) {
        respawnReceipt = nextReceiptNonce();
        InventoryProofClient.request(respawnReceipt, authority);
      }
      return;
    }
    if (motor != null) {
      long started = System.nanoTime();
      if (motor.generation != authority || !motor.authorized(false))
        motor.finish("cancelled", "Effect authority fenced", false);
      else motor.tick();
      long elapsed = System.nanoTime() - started;
      motorTickNanos += elapsed;
      motorTickMaxNanos = Math.max(motorTickMaxNanos, elapsed);
      motorTickCount++;
    }
  }

  public void applyInput() {
    if (!managed() || client.options == null) return;
    var o = client.options;
    JsonObject controls = motor == null ? null : motor.controls;
    boolean targetsCurrent = motor != null && motor.targetsCurrent();
    o.forwardKey.setPressed(targetsCurrent && pressed(controls, "forward"));
    o.backKey.setPressed(targetsCurrent && pressed(controls, "back"));
    o.leftKey.setPressed(targetsCurrent && pressed(controls, "left"));
    o.rightKey.setPressed(targetsCurrent && pressed(controls, "right"));
    o.jumpKey.setPressed(targetsCurrent && pressed(controls, "jump"));
    o.sprintKey.setPressed(targetsCurrent && pressed(controls, "sprint"));
    o.sneakKey.setPressed(targetsCurrent && pressed(controls, "sneak"));
    o.attackKey.setPressed(false);
    o.useKey.setPressed(false);
  }

  private boolean pressed(JsonObject controls, String key) {
    if (!connected || motor == null || motor.generation != authority || !motor.authorized(false)
        || motor.lifeId != lifecycle.lifeId() || !lifecycle.ready()) return false;
    boolean value;
    if (motor.kind.equals("navigate"))
      value = switch (key) {
        case "forward" -> motor.navForward;
        case "back" -> motor.navBack;
        case "left" -> motor.navLeft;
        case "right" -> motor.navRight;
        case "jump" -> motor.navJump;
        default -> false;
      };
    else value = controls != null && controls.has(key) && controls.get(key).getAsBoolean();
    if (value) motor.emissions |= EffectOutcome.WORLD_EFFECT;
    return value;
  }

  private void neutralize() {
    sounds.clear();
    blocks.clear();
    entities.clear();
    blockIncarnations.invalidate(); entityIncarnations.invalidate();
    if (respawnRequest != 0) {
      long id = respawnRequest;
      respawnRequest = 0; respawnReceipt = 0;
      boolean requested = respawnEmittedNanos != 0;
      reply(id, respawnResult(requested ? "unknown" : "cancelled",
          requested ? "Respawn request was fenced; its outcome is not confirmed and will not be replayed"
              : "Respawn cancelled before the vanilla request was emitted", false), null);
    }
    rejectObservations("Observation authority fenced");
    if (motor != null) motor.finish("cancelled", "Native effect cancelled", false);
    applyInput();
    if (client.interactionManager != null) client.interactionManager.cancelBlockBreaking();
    if (client.player != null) {
      client.player.stopUsingItem();
    }
  }

  private void rejectObservations(String reason) {
    for (long id : pendingObservations.values()) reply(id, null, reason);
    pendingObservations.clear();
  }

  private BlockPos targetBlock(TargetIncarnations.Target target) {
    if (target == null) return null;
    BlockPos position = blocks.get(target.targetId());
    return position != null && blockIncarnations.current(position, target, incarnationSignals.space(), lifecycle.lifeId()) ? position : null;
  }

  private Entity targetEntity(TargetIncarnations.Target target) {
    if (target == null) return null;
    Entity e = entities.get(target.targetId());
    return e != null && entityIncarnations.current(e.getUuid(), target, incarnationSignals.space(), lifecycle.lifeId())
        && authorizedEntity(e) ? e : null;
  }

  private boolean reachable(BlockPos pos) {
    return pos != null
        && client.player.getEyePos().squaredDistanceTo(pos.toCenterPos()) <= 25
        && clearLine(pos.toCenterPos(), pos)
        && client
            .world
            .raycast(
                new RaycastContext(
                    client.player.getEyePos(),
                    pos.toCenterPos(),
                    RaycastContext.ShapeType.OUTLINE,
                    RaycastContext.FluidHandling.NONE,
                    client.player))
            .getBlockPos()
            .equals(pos);
  }

  private final class Motor {
    final long id;
    final NativeEffectContract.Received received;
    final TargetIncarnations.Target targetReference, tableReference, gazeReference, interactionReference;
    final JsonObject action;
    final String kind, arrivalMode;
    final long generation, receivedNanos;
    final long admittedNanos = System.nanoTime();
    final long lifeId = lifecycle.lifeId();
    final CameraMotion.State camera = new CameraMotion.State();
    final NavigationGaze.Output routeGaze = new NavigationGaze.Output();
    final NavigationGaze.Movement steering = new NavigationGaze.Movement();
    final double[] route = new double[39];
    int routePoints;
    long routeSampled;
    long routeBlockedSince, navigationProgressSince;
    double bestArrivalGap = Double.POSITIVE_INFINITY;
    boolean navigationProgressArmed, positionRange;
    String navigationStopReason;
    double navigationStartDistanceSquared, navigationCurrentDistanceSquared;
    String placementPreflightReason = "not_checked", placementLocalResult;
    boolean equipmentEffectEmitted, placementEffectEmitted, movementStartOnGround;
    Vec3d sampledPosition;
    JsonObject startPose;
    double travelDistance, rotationYaw, rotationPitch;
    float sampledYaw, sampledPitch;
    long started = System.nanoTime();
    JsonObject controls;
    JsonObject inventoryBefore;
    JsonObject serverInventoryAfter;
    String targetName;
    String pickupItem;
    boolean completingPickup;
    long pickupReceiptDeadline;
    net.minecraft.block.BlockState targetStateBefore;
    BlockPos target, confirmationPosition;
    Entity entity;
    // Only this owner's successfully admitted bindings survive projection refreshes.
    // The incarnation stores, not the bounded observation maps, revoke these bindings.
    BlockPos targetBinding, tableBinding, gazeBinding, interactionBinding;
    Entity targetEntityBinding, tableEntityBinding, gazeEntityBinding, interactionEntityBinding;
    boolean bindingsResolved;
    float yaw, pitch;
    double yawVelocity, pitchVelocity;
    boolean looking,
        issued,
        authoritativeRejection,
        blockConfirmed,
        serverBlockRemoved,
        ready,
        completingMove,
        completedMovementEffect,
        navForward,
        navBack,
        navLeft,
        navRight,
        navJump;
    int emissions, ticks, initialCount, sentSequence = -1, receiptNonce, attackNonce;
    Integer damageOutcome;
    Vec3d initial, navigationGoal;
    long duration = 1000;
    long moveReceiptDeadline;
    JsonObject applicationRejection;
    VisibleInventory equipmentSession;

    boolean inventoryAuthority() {
      return motor == this && generation == authority && authorized(false)
          && lifeId == lifecycle.lifeId() && lifecycle.ready();
    }

    VisibleInventory inventorySession() {
      return kind.equals("craft") ? Recipes.session() : equipmentSession;
    }

    boolean startEquipment(String item, String destination) {
      equipmentSession = new VisibleInventory(client, false, this::inventoryAuthority);
      return equipmentSession.beginEquip(item, destination);
    }

    void inventoryEmissions() {
      VisibleInventory session = inventorySession();
      if (session != null && session.emitted()) {
        emissions |= EffectOutcome.WORLD_EFFECT;
        if (kind.equals("place")) equipmentEffectEmitted = true;
      }
    }

    Motor(long id, NativeEffectContract.Received received, long generation, long receivedNanos) {
      this.id = id;
      this.received = received;
      this.action = received.action();
      this.generation = generation;
      this.receivedNanos = receivedNanos;
      kind = action.get("kind").getAsString();
      arrivalMode = action.has("arrival") ? action.get("arrival").getAsString() : "position";
      targetReference = action.has("target") ? NativeEffectContract.target(action.getAsJsonObject("target")) : null;
      tableReference = action.has("table") ? NativeEffectContract.target(action.getAsJsonObject("table")) : null;
      JsonObject gaze = action.has("gaze") ? action.getAsJsonObject("gaze") : null;
      gazeReference = gaze != null && gaze.has("target") ? NativeEffectContract.target(gaze.getAsJsonObject("target")) : null;
      JsonObject interaction = action.has("interaction") ? action.getAsJsonObject("interaction") : null;
      interactionReference = interaction != null && interaction.has("target") ? NativeEffectContract.target(interaction.getAsJsonObject("target")) : null;
    }

    boolean authorized(boolean checkScreen) {
      return (checkScreen
          ? effectAuthority.validateApplication(received.owner(), received.compatibilityHash(), received.expectedScreen())
          : effectAuthority.validateApplication(received.owner(), received.compatibilityHash())) == EffectAuthority.Rejection.NONE;
    }

    boolean current(TargetIncarnations.Target reference) {
      if (reference == null) return true;
      BlockPos block = bindingsResolved ? boundBlock(reference) : blocks.get(reference.targetId());
      if (block != null) return blockIncarnations.current(block, reference, incarnationSignals.space(), lifecycle.lifeId());
      Entity entity = bindingsResolved ? boundEntity(reference) : entities.get(reference.targetId());
      return entity != null && !entity.isRemoved()
          && entityIncarnations.current(entity.getUuid(), reference, incarnationSignals.space(), lifecycle.lifeId());
    }

    BlockPos boundBlock(TargetIncarnations.Target reference) {
      if (reference == targetReference) return targetBinding;
      if (reference == tableReference) return tableBinding;
      if (reference == gazeReference) return gazeBinding;
      if (reference == interactionReference) return interactionBinding;
      return null;
    }

    Entity boundEntity(TargetIncarnations.Target reference) {
      if (reference == targetReference) return targetEntityBinding;
      if (reference == tableReference) return tableEntityBinding;
      if (reference == gazeReference) return gazeEntityBinding;
      if (reference == interactionReference) return interactionEntityBinding;
      return null;
    }

    void resolveBindings() {
      if (targetReference != null) {
        targetBinding = targetBlock(targetReference);
        targetEntityBinding = targetEntity(targetReference);
      }
      if (tableReference != null) {
        tableBinding = targetBlock(tableReference);
        tableEntityBinding = targetEntity(tableReference);
      }
      if (gazeReference != null) {
        gazeBinding = targetBlock(gazeReference);
        gazeEntityBinding = targetEntity(gazeReference);
      }
      if (interactionReference != null) {
        interactionBinding = targetBlock(interactionReference);
        interactionEntityBinding = targetEntity(interactionReference);
      }
      bindingsResolved = true;
    }

    boolean targetsCurrent() {
      return current(targetReference) && current(tableReference) && current(gazeReference) && current(interactionReference);
    }

    void rejectApplication(String stage) {
      EffectAuthority.Rejection rejection = effectAuthority.validateApplication(
          received.owner(), received.compatibilityHash(), received.expectedScreen());
      applicationRejection = new JsonObject();
      applicationRejection.addProperty("stage", stage);
      applicationRejection.addProperty("reason", rejection == EffectAuthority.Rejection.NONE ? "TARGET" : rejection.name());
      applicationRejection.addProperty("targets_current", targetsCurrent());
      applicationRejection.add("expected_scope", NativeEffectContract.scope(received.owner().scope()));
      EffectAuthority.Owner activeOwner = effectAuthority.owner();
      applicationRejection.add("current_owner_scope", activeOwner == null ? JsonNull.INSTANCE : NativeEffectContract.scope(activeOwner.scope()));
      applicationRejection.addProperty("current_native_generation", authority);
      applicationRejection.addProperty("current_life_id", lifecycle.lifeId());
      applicationRejection.add("current_space", incarnationSignals.space() == null ? JsonNull.INSTANCE : NativeEffectContract.space(incarnationSignals.space()));
      applicationRejection.add("expected_screen", NativeEffectContract.screen(received.expectedScreen()));
      applicationRejection.add("current_screen", NativeEffectContract.screen(incarnationSignals.screen()));
      if (targetReference != null) {
        applicationRejection.add("target_reference", NativeEffectContract.target(targetReference));
        applicationRejection.addProperty("target_current", current(targetReference));
        applicationRejection.addProperty("target_in_current_observation", blocks.containsKey(targetReference.targetId()) || entities.containsKey(targetReference.targetId()));
      }
      finish("failed", "Scope, screen or target incarnation changed before game-thread application", false);
    }

    void start() {
      if (!authorized(true) || !targetsCurrent()) {
        rejectApplication("game_thread_start");
        return;
      }
      resolveBindings();
      if (!targetsCurrent()) {
        rejectApplication("game_thread_bindings");
        return;
      }
      if (kind.equals("navigate") && arrivalMode.equals("interaction") && targetBinding == null) {
        finish("failed", "Interaction arrival requires a block target; entity targets support position arrival only", false);
        return;
      }
      // Expected screen is an apply-time precondition. Only after the actual
      // baseline and target checks may this owner perform its own UI transition.
      if (client.currentScreen instanceof HandledScreen<?>) {
        var handler = client.player.currentScreenHandler;
        boolean custody = !handler.getCursorStack().isEmpty();
        int grid = handler instanceof net.minecraft.screen.CraftingScreenHandler ? 9
            : handler instanceof net.minecraft.screen.PlayerScreenHandler ? 4 : 0;
        for (int i = 1; i <= grid; i++) custody |= !handler.getSlot(i).getStack().isEmpty();
        if (custody) emissions |= EffectOutcome.WORLD_EFFECT;
        client.player.closeHandledScreen();
      }
      initial = client.player.getPos();
      movementStartOnGround = client.player.isOnGround();
      sampledPosition = initial;
      sampledYaw = client.player.getYaw();
      sampledPitch = client.player.getPitch();
      startPose = pose();
      CameraMotion.reset(camera, sampledYaw, sampledPitch, System.nanoTime());
      target = targetBinding;
      entity = targetEntityBinding;
      if (target != null) {
        targetStateBefore = client.world.getBlockState(target);
        targetName = Registries.BLOCK.getId(targetStateBefore.getBlock()).getPath();
        confirmationPosition =
            kind.equals("place")
                ? target.offset(
                    Objects.requireNonNull(Direction.byName(action.get("face").getAsString())))
                : target;
      }
      if (action.has("duration_ms")) duration = action.get("duration_ms").getAsLong();
      if (kind.equals("move")) {
        controls = action.getAsJsonObject("controls");
        if (action.has("look")) setLook(action.getAsJsonObject("look"));
      } else if (kind.equals("look")) {
        setLook(action);
        duration = 8000;
      } else if (kind.equals("navigate")) {
        if (target == null && entity == null) {
          finish("failed", "Target is not currently visible", false);
          return;
        }
        navigationGoal = target != null ? target.toCenterPos() : entity.getPos();
        navigationStartDistanceSquared = initial.squaredDistanceTo(navigationGoal);
        navigationCurrentDistanceSquared = navigationStartDistanceSquared;
        if (entity instanceof ItemEntity dropped && !dropped.getStack().isEmpty())
          pickupItem = Registries.ITEM.getId(dropped.getStack().getItem()).getPath();
        duration = action.get("duration_ms").getAsLong();
        if (action.has("gaze") && action.getAsJsonObject("gaze").get("kind").getAsString().equals("free"))
          setLook(action.getAsJsonObject("gaze"));
      } else if (kind.equals("equip")) {
        duration = VisibleInventory.EQUIP_MS;
        issued = startEquipment(action.get("item").getAsString(), action.get("destination").getAsString());
        inventoryEmissions();
        if (!issued) finish(EffectOutcome.deadline(emissions), "Equipment preflight refused", false);
      } else if (kind.equals("craft")) {
        initialCount = beforeCount(action.get("item").getAsString());
        duration = VisibleInventory.craftMillis(action.get("executions").getAsInt());
        if (tableReference != null) {
          target = tableBinding;
          if (!reachable(target)) {
            finish("failed", "Crafting table is not currently visible and reachable", false);
            return;
          }
          aim(target.toCenterPos());
        }
      } else {
        if (target == null && entity == null) {
          finish("failed", "Target is not currently visible", false);
          return;
        }
        if ((kind.equals("dig") || kind.equals("place")) && !reachable(target)) {
          if (kind.equals("place")) placementPreflightReason = "target_not_reachable";
          finish("failed", "Block target is not currently reachable and visible", false);
          return;
        }
        if (kind.equals("attack") && (entity == null || entity.distanceTo(client.player) > 4.5)) {
          finish("failed", "Entity target is not currently within interaction range", false);
          return;
        }
        if (kind.equals("interact")
            && !(target != null && reachable(target)
                || entity != null && entity.distanceTo(client.player) <= 4.5)) {
          finish("failed", "Interaction target is not currently reachable and visible", false);
          return;
        }
        if (target != null) {
          Direction face =
              kind.equals("place") ? Direction.byName(action.get("face").getAsString()) : null;
          aim(
              face == null
                  ? target.toCenterPos()
                  : target.toCenterPos().add(Vec3d.of(face.getVector()).multiply(.5)));
        } else aim(entity.getBoundingBox().getCenter());
        duration = kind.equals("dig") ? 30000 : kind.equals("place") ? VisibleInventory.PLACE_MS : 4000;
      }
    }

    void setLook(JsonObject look) {
      yaw = (float) Math.toDegrees(look.get("yaw").getAsDouble());
      pitch = (float) -Math.toDegrees(look.get("pitch").getAsDouble());
      looking = true;
    }

    void aim(Vec3d position) {
      Vec3d d = position.subtract(client.player.getEyePos());
      yaw = (float) Math.toDegrees(Math.atan2(-d.x, d.z));
      pitch = (float) -Math.toDegrees(Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z)));
      looking = true;
    }

    void rotate() {
      if (!looking || generation != authority || !authorized(false) || lifeId != lifecycle.lifeId() || !lifecycle.ready() || client.player == null) return;
      VisibleInventory session = inventorySession();
      if (session != null && !session.closed()) return;
      if (!targetsCurrent()) {
        if (reconcileNearbyPickup()) return;
        if (!issued && !(kind.equals("dig") && serverBlockRemoved)) finish(EffectOutcome.deadline(emissions), "Target incarnation changed before camera/input application", false);
        return;
      }
      long now = System.nanoTime();
      float beforeYaw = client.player.getYaw(), beforePitch = client.player.getPitch();
      // Packet corrections are actual pose changes, not an alternate integration clock.
      camera.yaw = beforeYaw;
      camera.pitch = beforePitch;
      CameraMotion.advance(camera, yaw, pitch, motorProfile, now);
      yawVelocity = camera.yawVelocity;
      pitchVelocity = camera.pitchVelocity;
      client.player.setYaw((float) camera.yaw);
      client.player.setPitch((float) camera.pitch);
      if (Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - beforeYaw)) > .0001
          || Math.abs(client.player.getPitch() - beforePitch) > .0001) emissions |= EffectOutcome.CAMERA;
      samplePose();
    }

    JsonObject pose() {
      JsonObject value = new JsonObject();
      value.add("position", position(client.player.getPos()));
      value.addProperty("yaw", Math.toRadians(MathHelper.wrapDegrees(client.player.getYaw())));
      value.addProperty("pitch", Math.toRadians(-client.player.getPitch()));
      return value;
    }

    void samplePose() {
      if (client.player == null || sampledPosition == null) return;
      Vec3d p = client.player.getPos();
      travelDistance += p.distanceTo(sampledPosition);
      rotationYaw += Math.toRadians(Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - sampledYaw)));
      rotationPitch += Math.toRadians(Math.abs(client.player.getPitch() - sampledPitch));
      sampledPosition = p;
      sampledYaw = client.player.getYaw();
      sampledPitch = client.player.getPitch();
    }

    boolean supportedSpace(double x, double y, double z) {
      Vec3d p = client.player.getPos();
      Box box = client.player.getBoundingBox().offset(x - p.x, y - p.y, z - p.z);
      return client.world.isSpaceEmpty(client.player, box)
          && !client.world.isSpaceEmpty(client.player, box.offset(0, -.15, 0));
    }

    void sampleRoute() {
      // Fixed 4-block local horizon, at most eight half-block segments and forty support probes.
      // Geometry remains private; only collision/support shapes are queried, never material names.
      Vec3d p = client.player.getPos();
      double dx = navigationGoal.x - p.x, dz = navigationGoal.z - p.z;
      double distance = Math.sqrt(dx * dx + dz * dz);
      routePoints = 1;
      route[0] = p.x; route[1] = p.y; route[2] = p.z;
      if (distance < .001) return;
      double y = p.y;
      for (int i = 1; i <= 8; i++) {
        double d = Math.min(i * .5, distance);
        double x = p.x + dx / distance * d, z = p.z + dz / distance * d;
        boolean found = false;
        for (int h = 0; h < 5; h++) {
          double offset = h == 0 ? 0 : h % 2 == 1 ? (h + 1) * .25 : -h * .25;
          double candidate = y + offset;
          if (Math.abs(candidate - p.y) > 3 || !supportedSpace(x, candidate, z)) continue;
          int previous = (routePoints - 1) * 3;
          Box sweep = client.player.getBoundingBox().offset(
              (route[previous] + x) * .5 - p.x,
              Math.max(y, candidate) - p.y,
              (route[previous + 2] + z) * .5 - p.z);
          if (!client.world.isSpaceEmpty(client.player, sweep)) continue;
          int at = routePoints++ * 3;
          route[at] = x; route[at + 1] = candidate; route[at + 2] = z;
          y = candidate;
          found = true;
          break;
        }
        if (!found || d >= distance) break;
      }
    }

    boolean navigate() {
      long now = System.nanoTime();
      if (now - routeSampled >= 100000000L || routePoints == 0) {
        routeSampled = now;
        sampleRoute();
      }
      navForward = navBack = navLeft = navRight = navJump = false;
      if (routePoints < 2) return false;
      Vec3d p = client.player.getPos();
      double eyeHeight = client.player.getEyePos().y - p.y;
      if (!NavigationGaze.sample(route, routePoints, p.x, p.y, p.z, eyeHeight, 1.5, routeGaze)) return false;
      JsonObject gaze = action.has("gaze") ? action.getAsJsonObject("gaze") : null;
      String mode = gaze == null ? "navigation" : gaze.get("kind").getAsString();
      if (mode.equals("navigation")) {
        yaw = (float) routeGaze.yaw; pitch = (float) routeGaze.pitch; looking = true;
      } else if (mode.equals("target")) {
        BlockPos block = gazeBinding;
        Entity e = authorizedEntity(gazeEntityBinding) ? gazeEntityBinding : null;
        if (block != null && clearLine(block.toCenterPos(), block)) aim(block.toCenterPos());
        else if (e != null) aim(e.getBoundingBox().getCenter());
        else { finish(EffectOutcome.deadline(emissions), "Navigation gaze target is no longer visible", false); return false; }
      }
      double desiredYaw = Math.toDegrees(Math.atan2(-(routeGaze.x - p.x), routeGaze.z - p.z));
      NavigationGaze.steer(desiredYaw, client.player.getYaw(), steering);
      if (Math.abs(steering.yawError) > 35) return true;
      double radians = Math.toRadians(steering.worldYaw);
      double x = p.x - Math.sin(radians) * .55, z = p.z + Math.cos(radians) * .55;
      boolean level = supportedSpace(x, p.y, z);
      boolean step = !level && client.player.isOnGround()
          && client.world.isSpaceEmpty(client.player, client.player.getBoundingBox().offset(0, 1, 0))
          && (supportedSpace(x, p.y + .5, z) || supportedSpace(x, p.y + 1, z));
      boolean descent = !level && !step
          && (supportedSpace(x, p.y - .5, z) || supportedSpace(x, p.y - 1, z))
          && client.world.isSpaceEmpty(client.player, client.player.getBoundingBox().offset(x - p.x, 0, z - p.z));
      if (!level && !step && !descent) return false;
      navForward = steering.forward > 0;
      navBack = steering.forward < 0;
      navLeft = steering.strafe > 0;
      navRight = steering.strafe < 0;
      navJump = step;
      return true;
    }

    boolean aligned() {
      return Math.abs(MathHelper.wrapDegrees(yaw - client.player.getYaw())) < 3
          && Math.abs(pitch - client.player.getPitch()) < 3;
    }

    BlockHitResult placementPreflight() {
      Direction face = Direction.byName(action.get("face").getAsString());
      if (face == null) return refusePlacement("unknown_face");
      if (!reachable(target)) return refusePlacement("target_not_reachable");
      Vec3d surface = target.toCenterPos().add(Vec3d.of(face.getVector()).multiply(.499));
      BlockHitResult hit = client.world.raycast(new RaycastContext(
          client.player.getEyePos(), surface, RaycastContext.ShapeType.OUTLINE,
          RaycastContext.FluidHandling.NONE, client.player));
      if (hit.getType() != HitResult.Type.BLOCK
          || !hit.getBlockPos().equals(target) || hit.getSide() != face)
        return refusePlacement("requested_face_not_visible");
      ItemStack stack = ItemStack.EMPTY;
      String item = action.get("item").getAsString();
      for (int i = 0; i < client.player.getInventory().size(); i++) {
        ItemStack candidate = client.player.getInventory().getStack(i);
        if (!candidate.isEmpty() && Registries.ITEM.getId(candidate.getItem()).getPath().equals(item)) {
          stack = candidate;
          break;
        }
      }
      if (stack.isEmpty()) return refusePlacement("item_unavailable");
      if (!(stack.getItem() instanceof BlockItem blockItem))
        return refusePlacement("item_not_placeable_block");
      if (client.player.isSpectator()) return refusePlacement("spectator");
      if (!client.world.getWorldBorder().contains(target))
        return refusePlacement("target_outside_world_border");
      if (client.player.getItemCooldownManager().isCoolingDown(stack))
        return refusePlacement("item_cooldown");
      if (!blockItem.getBlock().isEnabled(client.world.getEnabledFeatures()))
        return refusePlacement("block_feature_disabled");
      ItemPlacementContext context = new ItemPlacementContext(client.player, Hand.MAIN_HAND, stack, hit);
      if (!context.canPlace()) return refusePlacement("destination_not_replaceable");
      context = blockItem.getPlacementContext(context);
      if (context == null) return refusePlacement("vanilla_placement_context_rejected");
      if (!client.world.isInBuildLimit(context.getBlockPos()))
        return refusePlacement("destination_outside_build_limit");
      if (!client.world.getWorldBorder().contains(context.getBlockPos()))
        return refusePlacement("destination_outside_world_border");
      // Invoke the actual BlockItem implementation, including subclass placement
      // and collision rules, without calling useOnBlock/place or sending a packet.
      var state = ((io.gameharness.nativeclient.mixin.BlockItemPlacementAccess) blockItem)
          .gameharness$getPlacementState(context);
      if (state == null) {
        var candidate = blockItem.getBlock().getPlacementState(context);
        if (candidate != null && !client.world.canPlace(
            candidate, context.getBlockPos(), net.minecraft.block.ShapeContext.of(client.player)))
          return refusePlacement("destination_collision");
        return refusePlacement("vanilla_placement_state_rejected");
      }
      confirmationPosition = context.getBlockPos().toImmutable();
      placementPreflightReason = "passed";
      return hit;
    }

    BlockHitResult refusePlacement(String reason) {
      placementPreflightReason = reason;
      finish(EffectOutcome.deadline(emissions),
          "Placement preflight refused: " + reason + "; no placement interaction dispatched", false);
      return null;
    }

    int count(String item) {
      int count = 0;
      for (int i = 0; i < client.player.getInventory().size(); i++) {
        var stack = client.player.getInventory().getStack(i);
        if (Registries.ITEM.getId(stack.getItem()).getPath().equals(item))
          count += stack.getCount();
      }
      return count;
    }

    void requestInventory() {
      if (receiptNonce == 0) {
        receiptNonce = NativeClient.this.nextReceiptNonce();
        InventoryProofClient.request(receiptNonce, generation);
      }
    }

    int serverCount(String item) {
      JsonObject counts = serverInventoryAfter.getAsJsonObject("counts");
      return counts.has(item) ? counts.get(item).getAsInt() : 0;
    }

    boolean serverInventoryClean() {
      return serverInventoryAfter != null && client.player != null
          && serverInventoryAfter.get("screen_sync_id").getAsInt() == client.player.playerScreenHandler.syncId
          && InventoryGestureFence.cleanCustody(serverInventoryAfter.get("cursor_count").getAsInt(),
              serverInventoryAfter.get("crafting_grid_count").getAsInt());
    }

    int beforeCount(String item) {
      return inventoryBefore.has(item) ? inventoryBefore.get(item).getAsInt() : 0;
    }

    // Collection can remove the selected entity before the requested range is
    // sampled. Stop emitting immediately; only an owned server inventory gain
    // can close this as success. Despawn/foreign collection remain unknown.
    boolean reconcileNearbyPickup() {
      if (completingPickup) return true;
      if (!kind.equals("navigate") || pickupItem == null || entity == null
          || current(targetReference) || !current(tableReference) || !current(gazeReference)
          || !current(interactionReference) || !authorized(false)
          || entity.getPos().distanceTo(client.player.getPos()) > 2
          || (emissions & EffectOutcome.WORLD_EFFECT) == 0) return false;
      completingPickup = true;
      pickupReceiptDeadline = System.nanoTime() + 1500000000L;
      navForward = navBack = navLeft = navRight = navJump = false;
      looking = false;
      yawVelocity = pitchVelocity = 0;
      applyInput();
      requestInventory();
      return true;
    }

    void tick() {
      if (!ready) {
        if ((System.nanoTime() - started) / 1000000 > 3000)
          finish(
              "failed",
              "Authoritative inventory baseline receipt did not arrive before dispatch",
              false);
        return;
      }
      if (completingMove) {
        if (System.nanoTime() >= moveReceiptDeadline)
          finish(
              "unknown",
              "Movement completed, but its authoritative inventory receipt did not arrive",
              false);
        return;
      }
      if (completingPickup) {
        if (System.nanoTime() >= pickupReceiptDeadline)
          finish("unknown", "Selected drop disappeared; authoritative pickup receipt timed out", false);
        return;
      }
      ticks++;
      samplePose();
      long elapsed = (System.nanoTime() - started) / 1000000;
      if (elapsed > duration) {
        if (kind.equals("move")) {
          completedMovementEffect = initial.squaredDistanceTo(client.player.getPos()) > .001;
          completingMove = true;
          moveReceiptDeadline = System.nanoTime() + 3000000000L;
          // End the held controls/camera at the requested duration, not after the receipt wait.
          controls = null;
          looking = false;
          yawVelocity = 0;
          pitchVelocity = 0;
          applyInput();
          if (client.interactionManager != null)
            client.interactionManager.cancelBlockBreaking();
          requestInventory();
        } else
          finish(
              EffectOutcome.deadline(emissions),
              "Action deadline reached without confirmed effect",
              false);
        return;
      }
      boolean completionOnly = kind.equals("dig") && serverBlockRemoved
          || issued && (kind.equals("place") || kind.equals("interact") || kind.equals("attack"))
          || kind.equals("craft") && issued && (Recipes.complete() || Recipes.ownsTableGrid(client));
      if (!targetsCurrent() && !completionOnly) {
        if (reconcileNearbyPickup()) return;
        finish(EffectOutcome.deadline(emissions), "Target incarnation changed before native effect application", false);
        return;
      }
      switch (kind) {
        case "look" -> {
          if (Math.abs(MathHelper.wrapDegrees(yaw - client.player.getYaw())) < .5
              && Math.abs(pitch - client.player.getPitch()) < .5
              && Math.abs(yawVelocity) < 5
              && Math.abs(pitchVelocity) < 5)
            finish("succeeded", "Camera reached target orientation", true);
        }
        case "move" -> {
          if (action.has("interaction") && ticks % 4 == 0)
            interactComposite(action.getAsJsonObject("interaction"));
        }
        case "navigate" -> {
          Vec3d goal = navigationGoal;
          double range = action.get("range").getAsDouble();
          double positionDistanceSquared = goal.squaredDistanceTo(client.player.getPos());
          navigationCurrentDistanceSquared = positionDistanceSquared;
          positionRange = positionDistanceSquared <= range * range;
          double arrivalDistanceSquared = positionDistanceSquared;
          boolean arrived = positionRange;
          if (arrivalMode.equals("interaction")) {
            arrivalDistanceSquared = goal.squaredDistanceTo(client.player.getEyePos());
            arrived = arrivalDistanceSquared <= range * range && reachable(target);
          }
          if (arrived) {
            finish("succeeded", arrivalMode.equals("interaction")
                ? "Block is visible and reachable within the requested eye-to-centre interaction range"
                : "Reached range of the last-authorized target location", true);
            return;
          }
          String envelopeRejection = NavigationEnvelope.rejection(
              navigationStartDistanceSquared, positionDistanceSquared);
          if (envelopeRejection != null) {
            navigationStopReason = envelopeRejection;
            finish("failed", String.format(Locale.ROOT,
                "Navigation refused: %s; start feet-to-target-centre %.3f m (limit %.1f m), "
                    + "current %.3f m (limit %.1f m). Observation block-lattice radius is not this distance bound",
                envelopeRejection, Math.sqrt(navigationStartDistanceSquared), NavigationEnvelope.START_LIMIT,
                Math.sqrt(positionDistanceSquared), NavigationEnvelope.CURRENT_LIMIT), false);
            return;
          }
          boolean feasibleRoute = navigate();
          if (motor != this) return;
          long now = System.nanoTime();
          if (feasibleRoute) routeBlockedSince = 0;
          else if (routeBlockedSince == 0) routeBlockedSince = now;
          double gap = Math.max(0, Math.sqrt(arrivalDistanceSquared) - range);
          if (bestArrivalGap - gap > .1) {
            bestArrivalGap = gap;
            navigationProgressSince = now;
          }
          // Grant one initial camera-settling interval, never a fresh interval
          // for each turn. Travel around the target cannot reset best-gap progress.
          if (!navigationProgressArmed && (!looking
              || CameraMotion.isSettled(camera, yaw, pitch, 3, 5)
              || now - started >= 750000000L)) {
            navigationProgressArmed = true;
            navigationProgressSince = now;
          }
          if (routeBlockedSince != 0 && now - routeBlockedSince >= 750000000L)
            navigationStopReason = "blocked";
          else if (navigationProgressArmed && now - navigationProgressSince >= 1500000000L)
            navigationStopReason = "no_progress";
          if (navigationStopReason != null)
            finish(EffectOutcome.deadline(emissions),
                navigationStopReason.equals("blocked")
                    ? "No feasible supported local route; choose another visible approach"
                    : "Navigation made no meaningful progress toward the requested arrival range", false);
        }
        case "dig" -> {
          if (client.world.getBlockState(target).isAir()) {
            if (serverBlockRemoved) finish("succeeded", "Server-confirmed target block removal", true);
            return;
          }
          if (!reachable(target)) {
            finish("failed", "Block is no longer reachable and visible", false);
            return;
          }
          if (aligned()) {
            var hit =
                client.world.raycast(
                    new RaycastContext(
                        client.player.getEyePos(),
                        target.toCenterPos(),
                        RaycastContext.ShapeType.OUTLINE,
                        RaycastContext.FluidHandling.NONE,
                        client.player));
            client.interactionManager.updateBlockBreakingProgress(target, hit.getSide());
            client.player.swingHand(Hand.MAIN_HAND);
          }
        }
        case "equip" -> {
          equipmentSession.tickEquip();
          inventoryEmissions();
          if (equipmentSession.failed()) {
            finish(EffectOutcome.deadline(emissions), "Visible equipment interrupted: " + equipmentSession.reason(), false);
            return;
          }
          if (equipmentSession.closed()) {
            requestInventory();
            if (serverInventoryAfter == null) return;
            String destination = action.get("destination").getAsString();
            int slot =
                switch (destination) {
                  case "hand" -> client.player.getInventory().selectedSlot;
                  case "off-hand" -> 40;
                  case "head" -> 39;
                  case "torso" -> 38;
                  case "legs" -> 37;
                  default -> 36;
                };
            JsonObject slots = serverInventoryAfter.getAsJsonObject("slots");
            boolean ok =
                issued
                    && serverInventoryClean()
                    && (!destination.equals("hand")
                        || serverInventoryAfter.get("selected_slot").getAsInt() == slot)
                    && slots.has(Integer.toString(slot))
                    && slots
                        .getAsJsonObject(Integer.toString(slot))
                        .get("name")
                        .getAsString()
                        .equals(action.get("item").getAsString());
            finish(
                ok ? "succeeded" : EffectOutcome.deadline(emissions),
                ok
                    ? "Equipped item confirmed by owned server inventory receipt"
                    : "Requested equipment not present in server inventory",
                ok);
          }
        }
        case "craft" -> {
          if (!issued) {
            if (looking && !aligned()) return;
            issued = Recipes.begin(client, action, target, this::inventoryAuthority);
            if (!issued) {
              finish("failed", "No unlocked compatible recipe or reachable crafting grid", false);
              return;
            }
            if (tableReference != null) emissions |= EffectOutcome.WORLD_EFFECT;
          }
          Recipes.tick(client);
          inventoryEmissions();
          if (Recipes.invalidated()) {
            finish(EffectOutcome.deadline(emissions), "Visible crafting interrupted: " + Recipes.session().reason(), false);
            return;
          }
          if (Recipes.complete()) {
            requestInventory();
            if (serverInventoryAfter == null) return;
            boolean gained =
                serverInventoryClean() && serverCount(action.get("item").getAsString()) - initialCount
                    >= Recipes.expectedGain();
            finish(
                gained ? "succeeded" : EffectOutcome.deadline(emissions),
                gained
                    ? "Requested craft quantity confirmed by owned server inventory receipt"
                    : "Requested crafted quantity not present in server inventory",
                gained);
          }
        }
        case "place", "interact", "attack" -> {
          if (!aligned()) return;
          if (!issued) {
            if (kind.equals("place")) {
              if (equipmentSession == null) {
                if (placementPreflight() == null) return;
                if (!startEquipment(action.get("item").getAsString(), "hand")) {
                  inventoryEmissions();
                  placementPreflightReason = "item_unavailable_before_equipment";
                  finish(EffectOutcome.deadline(emissions), "Placement item unavailable before equipment; no placement interaction dispatched", false);
                  return;
                }
              }
              // During a real transfer the item may be on the owned cursor,
              // not in an inventory slot. Recheck placement only once that
              // session has deposited it and closed with clean custody.
              equipmentSession.tickEquip();
              inventoryEmissions();
              if (equipmentSession.failed()) {
                finish(EffectOutcome.deadline(emissions), "Visible placement equipment interrupted: " + equipmentSession.reason(), false);
                return;
              }
              if (!equipmentSession.closed()) return;
              BlockHitResult faceHit = placementPreflight();
              if (faceHit == null) return;
              initialCount = beforeCount(action.get("item").getAsString());
              if (!Registries.ITEM.getId(client.player.getMainHandStack().getItem()).getPath()
                  .equals(action.get("item").getAsString())) {
                placementPreflightReason = "equipment_not_locally_ready";
                finish("failed", "Placement equipment not locally ready; no placement interaction dispatched", false);
                return;
              }
              // Vanilla sends a sequenced interaction even when local prediction
              // returns PASS/FAIL. Neither result establishes authoritative no-effect.
              emissions |= EffectOutcome.WORLD_EFFECT;
              issued = true; ticks = 0;
              ActionResult local = client.interactionManager.interactBlock(
                  client.player, Hand.MAIN_HAND, faceHit);
              placementLocalResult = local.isAccepted() ? "accepted"
                  : local instanceof ActionResult.Fail ? "fail" : "pass";
            } else if (authorizedEntity(entity) && entity.distanceTo(client.player) <= 4.5) {
              issued = true; ticks = 0;
              emissions |= EffectOutcome.WORLD_EFFECT;
              if (kind.equals("attack")) {
                attackNonce = NativeClient.this.nextReceiptNonce();
                AttackProofClient.arm(attackNonce, generation);
                client.interactionManager.attackEntity(client.player, entity);
              } else
                client.interactionManager.interactEntity(client.player, entity, Hand.MAIN_HAND);
            } else if (target != null && reachable(target) && !kind.equals("attack")) {
              issued = true; ticks = 0;
              emissions |= EffectOutcome.WORLD_EFFECT;
              client.interactionManager.interactBlock(
                  client.player,
                  Hand.MAIN_HAND,
                  client.world.raycast(
                      new RaycastContext(
                          client.player.getEyePos(),
                          target.toCenterPos(),
                          RaycastContext.ShapeType.OUTLINE,
                          RaycastContext.FluidHandling.NONE,
                          client.player)));
            } else {
              finish("failed", "Interaction target unavailable", false);
              return;
            }
          } else if (ticks >= 8) {
            if (kind.equals("place")) {
              requestInventory();
              if (serverInventoryAfter == null) return;
            }
            if (kind.equals("attack")) {
              if (damageOutcome == null) return;
              if (damageOutcome == 0) {
                authoritativeRejection = true;
                finish(
                    "failed", "Vanilla owned attack was processed without accepted damage", false);
                return;
              }
              finish(
                  damageOutcome == 1 ? "succeeded" : "unknown",
                  damageOutcome == 1
                      ? "Owned vanilla attack damage confirmed"
                      : "Vanilla attack processed without a supported damage receipt",
                  damageOutcome == 1);
              return;
            }
            boolean confirmed =
                kind.equals("place")
                    ? blockConfirmed
                        && !client.world.getBlockState(confirmationPosition).isAir()
                        && serverCount(action.get("item").getAsString()) < initialCount
                    : client.currentScreen != null
                        || target != null
                            && blockConfirmed
                            && clearLine(target.toCenterPos(), target)
                            && !client.world.getBlockState(target).equals(targetStateBefore);
            finish(
                confirmed ? "succeeded" : "unknown",
                confirmed
                    ? "Observed interaction effect"
                    : "Interaction sent; resulting effect not confirmed",
                confirmed);
          }
        }
        default -> finish("failed", "Unsupported action kind", false);
      }
    }

    void interactComposite(JsonObject interaction) {
      boolean attack = interaction.get("kind").getAsString().equals("attack");
      Entity e =
          interactionReference != null
              ? interactionEntityBinding
              : client.crosshairTarget instanceof EntityHitResult hit ? hit.getEntity() : null;
      if (e != null && authorizedEntity(e) && e.distanceTo(client.player) <= 4.5) {
        emissions |= EffectOutcome.WORLD_EFFECT;
        if (attack) client.interactionManager.attackEntity(client.player, e);
        else client.interactionManager.interactEntity(client.player, e, Hand.MAIN_HAND);
        return;
      }
      BlockPos pos =
          interactionReference != null
              ? interactionBinding
              : client.crosshairTarget instanceof BlockHitResult hit ? hit.getBlockPos() : null;
      if (pos != null && reachable(pos)) {
        emissions |= EffectOutcome.WORLD_EFFECT;
        BlockHitResult hit =
            client.world.raycast(
                new RaycastContext(
                    client.player.getEyePos(),
                    pos.toCenterPos(),
                    RaycastContext.ShapeType.OUTLINE,
                    RaycastContext.FluidHandling.NONE,
                    client.player));
        if (attack) client.interactionManager.updateBlockBreakingProgress(pos, hit.getSide());
        else client.interactionManager.interactBlock(client.player, Hand.MAIN_HAND, hit);
        return;
      }
      if (!attack && interactionReference == null) {
        emissions |= EffectOutcome.WORLD_EFFECT;
        client.interactionManager.interactItem(client.player, Hand.MAIN_HAND);
      }
    }

    void finish(String status, String summary, boolean effect) {
      if (motor != this) return;
      inventoryEmissions();
      VisibleInventory inventorySession = inventorySession();
      status =
          EffectOutcome.close(
              status, emissions, serverInventoryAfter != null || authoritativeRejection);
      boolean reportInteractionReach = kind.equals("navigate") && arrivalMode.equals("interaction")
          && target != null && client.player != null && client.world != null
          && generation == authority && lifeId == lifecycle.lifeId() && lifecycle.ready()
          && authorized(false) && targetsCurrent();
      // Arrival success already proved reach on this application. Negative
      // feedback probes once at close, never on every out-of-range motor tick.
      boolean interactionReachable = reportInteractionReach
          && (status.equals("succeeded") && effect || reachable(target));
      boolean reportMovement = (kind.equals("move") || kind.equals("navigate"))
          && initial != null && client.player != null && client.world != null
          && generation == authority && lifeId == lifecycle.lifeId() && lifecycle.ready()
          && authorized(false);
      if (reportMovement && navigationGoal != null)
        navigationCurrentDistanceSquared = navigationGoal.squaredDistanceTo(client.player.getPos());
      motor = null;
      if (equipmentSession != null) equipmentSession.cancel(true);
      Recipes.cancel(true);
      JsonObject inventoryUi = inventorySession == null ? null : inventorySession.diagnostics();
      controls = null;
      looking = false;
      applyInput();
      if (client.interactionManager != null) client.interactionManager.cancelBlockBreaking();
      if (client.player != null) client.player.stopUsingItem();
      JsonObject outcome = result(status, summary, effect);
      JsonObject evidence = outcome.getAsJsonObject("evidence");
      samplePose();
      evidence.addProperty("life_id", lifeId);
      evidence.addProperty("native_generation", generation);
      evidence.addProperty("world_effect_emitted", (emissions & EffectOutcome.WORLD_EFFECT) != 0);
      evidence.addProperty("camera_changed", (emissions & EffectOutcome.CAMERA) != 0);
      if (inventoryUi != null) evidence.add("native_inventory_ui", inventoryUi);
      if (kind.equals("navigate")) {
        evidence.addProperty("arrival_mode", arrivalMode);
        evidence.addProperty("position_range", positionRange);
        if (reportInteractionReach) evidence.addProperty("interaction_reachable", interactionReachable);
        if (navigationStopReason != null) evidence.addProperty("navigation_stop_reason", navigationStopReason);
        if (navigationGoal != null) {
          evidence.addProperty("navigation_start_distance", Math.sqrt(navigationStartDistanceSquared));
          evidence.addProperty("navigation_current_distance", Math.sqrt(navigationCurrentDistanceSquared));
          evidence.addProperty("navigation_start_limit", NavigationEnvelope.START_LIMIT);
          evidence.addProperty("navigation_current_limit", NavigationEnvelope.CURRENT_LIMIT);
        }
      }
      if (kind.equals("place")) {
        evidence.addProperty("placement_preflight_reason", placementPreflightReason);
        evidence.addProperty("equipment_effect_emitted", equipmentEffectEmitted);
        evidence.addProperty("placement_effect_emitted", placementEffectEmitted);
        if (placementLocalResult != null) evidence.addProperty("placement_local_result", placementLocalResult);
      }
      if (reportMovement) {
        Vec3d end = client.player.getPos();
        evidence.addProperty("net_displacement", end.distanceTo(initial));
        evidence.addProperty("horizontal_displacement", Math.hypot(end.x - initial.x, end.z - initial.z));
        evidence.addProperty("height_change", end.y - initial.y);
        evidence.addProperty("movement_start_on_ground", movementStartOnGround);
        Box body = client.player.getBoundingBox();
        JsonObject mechanical = new JsonObject();
        mechanical.addProperty("on_ground", client.player.isOnGround());
        mechanical.addProperty("support_within_0_15", !client.world.isSpaceEmpty(client.player,
            new Box(body.minX, body.minY - .15, body.minZ, body.maxX, body.minY, body.maxZ)));
        mechanical.addProperty("headroom_1m_clear",
            client.world.isSpaceEmpty(client.player, body.stretch(0, 1, 0)));
        mechanical.addProperty("body_space_clear", client.world.isSpaceEmpty(client.player, body));
        mechanical.addProperty("horizontal_collision", client.player.horizontalCollision);
        mechanical.addProperty("vertical_collision", client.player.verticalCollision);
        evidence.add("movement_end", mechanical);
      }
      if (applicationRejection != null) evidence.add("application_rejection", applicationRejection);
      if (targetReference != null) evidence.add("target", NativeEffectContract.target(targetReference));
      if (targetReference != null && target != null) {
        evidence.addProperty("target_in_observation_projection", blocks.containsKey(targetReference.targetId()));
        evidence.addProperty("target_incarnation_current", blockIncarnations.current(
            target, targetReference, incarnationSignals.space(), lifecycle.lifeId()));
        evidence.addProperty("target_client_air", client.world != null && client.world.getBlockState(target).isAir());
        evidence.addProperty("server_block_removed", serverBlockRemoved);
      }
      evidence.addProperty("life_fenced", lifeId != lifecycle.lifeId() || !lifecycle.ready());
      evidence.addProperty("motor_profile", motorProfile.name().toLowerCase(Locale.ROOT));
      evidence.add("start_pose", startPose);
      if (client.player != null) evidence.add("end_pose", pose());
      evidence.addProperty("travel_distance", travelDistance);
      evidence.addProperty("rotation_yaw_radians", rotationYaw);
      evidence.addProperty("rotation_pitch_radians", rotationPitch);
      evidence.addProperty("native_action_ms", ready ? (System.nanoTime() - started) / 1e6 : 0);
      evidence.addProperty("native_baseline_receipt_confirmed", ready);
      if (ready) evidence.addProperty("native_dispatch_receipt_ms", (started - receivedNanos) / 1e6);
      else evidence.add("native_dispatch_receipt_ms", JsonNull.INSTANCE);
      evidence.addProperty("native_dispatch_queue_ms", (admittedNanos - receivedNanos) / 1e6);
      evidence.addProperty("native_baseline_receipt_wait_ms", ready ? (started - admittedNanos) / 1e6 : (System.nanoTime() - admittedNanos) / 1e6);
      if (target != null) evidence.add("target_position", position(target.toCenterPos()));
      if (kind.equals("dig") && effect && serverBlockRemoved) {
        evidence.addProperty("block_removed", true);
        evidence.addProperty("source", "server_block_update");
      }
      evidence.add("inventory_before", inventoryBefore);
      if (targetName != null) evidence.addProperty("target_name", targetName);
      if (serverInventoryAfter != null) {
        evidence.add("inventory_after", serverInventoryAfter.get("counts"));
        evidence.addProperty("inventory_receipt_confirmed", true);
        if (inventoryUi != null) {
          evidence.addProperty("inventory_custody_confirmed", serverInventoryClean());
          evidence.add("inventory_selected_slot", serverInventoryAfter.get("selected_slot"));
          evidence.add("inventory_cursor_count", serverInventoryAfter.get("cursor_count"));
          evidence.add("inventory_crafting_grid_count", serverInventoryAfter.get("crafting_grid_count"));
        }
        if (completingPickup) {
          evidence.addProperty("pickup_item", pickupItem);
          evidence.addProperty("pickup_inventory_gain", Math.max(0, serverCount(pickupItem) - beforeCount(pickupItem)));
        }
      } else if (client.player != null) evidence.add("inventory_after", inventoryCounts());
      reply(id, outcome, null);
    }
  }
}
