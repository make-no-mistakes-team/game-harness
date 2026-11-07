package io.gameharness.nativeclient;

import com.google.gson.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderContext;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.HandledScreen;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
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
  private final Map<Long, Long> pendingGuiReads = new LinkedHashMap<>();
  private record ControllerRead(SoundProjection.Cursor cursor, long deadline) {}
  private final Map<Long, ControllerRead> pendingControllerReads = new LinkedHashMap<>();
  private record ResidentRead(long id, SoundProjection.Cursor cursor, long deadline, StreamOwner stream) {}
  private ResidentRead pendingResidentRead;
  private final ControllerSamplePhase controllerSamples = new ControllerSamplePhase();
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
  private NativeEvaluationConfig evaluationConfig;
  private NativeEvaluationGate evaluationGate;
  private volatile Integer actualControlSendBufferBytes;
  private EffectAuthority.Owner evaluationOwner;
  private long evaluationControllerGeneration, evaluationTriggerNanos;
  private EffectAuthority.VisibleScreenRef evaluationOriginalScreen;
  private EffectAuthority.Screen evaluationReplacementScreen;
  private String evaluationOriginalType, evaluationReplacementType;
  private String evaluationReplacementStatus = "not_armed";
  private boolean evaluationTriggered, evaluationTriggerHeld;
  private ClientIncarnationSignals incarnationSignals;
  private JsonObject descriptor;
  private String compatibilityHash;
  private final Map<Long, NativeEffectContract.Received> effectRequests = new HashMap<>();
  private final TargetIncarnations<BlockPos> blockIncarnations = new TargetIncarnations<>(256);
  private final TargetIncarnations<UUID> entityIncarnations = new TargetIncarnations<>(256);
  private final ScreenIncarnations screenIncarnations = new ScreenIncarnations();
  private final NativeReplyTiming replyTiming = new NativeReplyTiming();
  private final NativeRenderSnapshot renderSnapshot = new NativeRenderSnapshot();
  private volatile long clientTick;
  private Motor keyboardSamplingOwner;
  private NativeInputs ordinaryInput, lastOrdinaryInput, ordinarySamplingOwner;
  private VisibleScreen visibleInput;
  private VisibleScreenView visibleView;
  private ControllerBody controllerBody;
  private static final class OpportunityTrace {
    final NativePreparationTrace.Identity identity;
    final NativePreparationTrace collector;
    volatile boolean retired;
    boolean serializationUnavailablePending;
    NativePreparationTrace.Batch pending, committed;
    OpportunityTrace(NativePreparationTrace.Identity identity, NativePreparationTrace collector) {
      this.identity = identity; this.collector = collector;
    }
  }
  private record StreamOwner(NativeControllerContract.Grant grant, ControllerInputQueue queue, OpportunityTrace trace) {}
  // Reply synchronization owns consumers/tokens; producers only use their owner's collector.
  private final ArrayDeque<OpportunityTrace> opportunityTraces = new ArrayDeque<>(4);
  private OpportunityTrace unavailableOpportunityTrace;
  private volatile OpportunityTrace preparingOpportunityTrace;
  private volatile boolean opportunityRetirementDraining;
  private record CapturedControllerFrame(long tick, long nanos, long life, EffectAuthority.Space space) {}
  private volatile StreamOwner streamOwner;
  private StreamInputs streamInputs;
  private JsonObject lastStreamAck, streamRetirement;
  private ControllerInputQueue.LeaseCheck streamRetirementLease;
  private ControllerInputQueue.Entry streamGuiEntry;
  private VisibleScreen streamGuiDriver;
  private final Map<Long, CapturedControllerFrame> controllerCaptures = new LinkedHashMap<>();
  private record ControllerEffect(JsonObject value, int bytes) {}
  private final ArrayDeque<ControllerEffect> controllerEffects = new ArrayDeque<>(8);
  private int controllerEffectBytes;
  private long controllerEffectsOmitted;
  private final java.util.concurrent.atomic.AtomicReference<JsonObject> controllerSamplePending =
      new java.util.concurrent.atomic.AtomicReference<>();
  private long controllerFrameSequence;
  private final ControllerWorldRefresh controllerWorld = new ControllerWorldRefresh(this::acquirePermittedWorld);
  private final Function<BlockPos, JsonElement> controllerBlockReference = this::controllerBlockReference;
  private final Function<Entity, JsonElement> controllerEntityReference = this::controllerEntityReference;

  private int nextReceiptNonce() {
    if (receiptNonce == Integer.MAX_VALUE) throw new IllegalStateException("Native receipt nonce range exhausted");
    return ++receiptNonce;
  }

  private void fenceAuthority() {
    renderSnapshot.invalidate();
    if (evaluationGate != null) evaluationGate.cancel(effectAuthority.owner());
    effectAuthority.emergencyStop();
    StreamOwner stream = streamOwner;
    if (stream != null) stream.queue().fence("native_authority_fenced");
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
    notice.addProperty("neutralized", motor == null && ordinaryInput == null && visibleInput == null && streamInputs == null);
    message.add("notice", notice);
    output.critical(message.toString());
  }

  public void spaceReceived() { incarnationSignals.authoritativeSpaceReceived(); }
  public void scopeUnavailable() { if (incarnationSignals != null) incarnationSignals.loading(); }
  public void screenReceived() {
    VisibleScreen.screenChanged();
    if (ordinaryInput != null && client.currentScreen != null) ordinaryInput.screenChanged(clientTick);
    if (streamInputs != null && client.currentScreen != null) streamInputs.screenChanged();
    if (incarnationSignals != null) incarnationSignals.viewReceived();
  }
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
  private NativeControlWriter output;
  private final java.util.concurrent.atomic.AtomicReference<JsonObject> retirementPending =
      new java.util.concurrent.atomic.AtomicReference<>();
  private final java.util.concurrent.atomic.AtomicBoolean retirementReserved = new java.util.concurrent.atomic.AtomicBoolean();
  private final Map<Long, Boolean> retirementReplies = new java.util.concurrent.ConcurrentHashMap<>();
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
    if (ordinaryInput != null && (packet instanceof net.minecraft.network.packet.c2s.play.PlayerMoveC2SPacket
        || packet instanceof net.minecraft.network.packet.c2s.play.PlayerInputC2SPacket
        || packet instanceof net.minecraft.network.packet.c2s.play.PlayerInteractEntityC2SPacket
        || packet instanceof net.minecraft.network.packet.c2s.play.PlayerInteractItemC2SPacket
        || packet instanceof PlayerInteractBlockC2SPacket || packet instanceof PlayerActionC2SPacket
        || packet instanceof net.minecraft.network.packet.c2s.play.ClientCommandC2SPacket))
      ordinaryInput.packetEmitted();
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

  public String soundStreamId() {
    return connected && incarnationSignals != null && incarnationSignals.space() != null
        && (lifecycle.status() == PlayerLifecycle.Status.ALIVE || lifecycle.status() == PlayerLifecycle.Status.DEAD)
        ? sounds.streamId() : null;
  }

  public void soundDelivered(String streamId, int kind, double dx, double dy, double dz, long wallMillis, long nativeNanos) {
    if (connected) sounds.accept(streamId, kind, dx, dy, dz, wallMillis, nativeNanos);
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
      evaluationConfig = NativeEvaluationConfig.read(config.get("evaluation"));
      if (evaluationConfig != null) evaluationGate = new NativeEvaluationGate(evaluationConfig);
      if (config.has("motor_profile"))
        motorProfile = CameraMotion.Profile.valueOf(config.get("motor_profile").getAsString().toUpperCase(Locale.ROOT));
      effectAuthority = new EffectAuthority(NativeEffectContract.id(config, "session_id"),
          NativeEffectContract.id(config, "world_id"), NativeEffectContract.counter(config, "epoch"));
      descriptor = NativeContractResource.descriptor(motorProfile.name().toLowerCase(Locale.ROOT));
      compatibilityHash = NativeContractResource.hash(descriptor);
      incarnationSignals = new ClientIncarnationSignals(client, effectAuthority, blockIncarnations, entityIncarnations, screenIncarnations,
          new ClientIncarnationSignals.Listener() {
            public void scopeFenced() {
              renderSnapshot.invalidate();
              resetSensingScope();
              authority = effectAuthority.cancellationGeneration();
              if (respawnRequest != 0 && lifecycle.status() == PlayerLifecycle.Status.RESPAWNING) {
                blocks.clear(); entities.clear(); rejectObservations("Observation predates replacement space"); applyInput();
              } else neutralize();
              bindScopeIfReady(); publishScope();
            }
            public void screenChanged() { renderSnapshot.invalidate(); controllerWorld.invalidate(); publishScope(); }
          });
    } catch (Exception e) {
      throw new IllegalStateException("Private native configuration unavailable");
    }
    AdmissionClient.install();
    InventoryProofClient.install();
    GuiTransactionProofClient.install();
    visibleView = new VisibleScreenView(client, screenIncarnations);
    controllerBody = new ControllerBody(client, renderSnapshot, lifecycle::lifeId, incarnationSignals::space);
    AttackProofClient.install();
    ClientTickEvents.START_CLIENT_TICK.register(c -> tick());
    ClientTickEvents.END_CLIENT_TICK.register(c -> inputTickEnded());
    WorldRenderEvents.START.register(this::worldRenderStarted);
    video = new Video(config);
    Thread control = new Thread(this::control, "gameharness-control");
    control.setDaemon(true);
    control.start();
  }

  public void renderStarted() {
    renderSnapshot.begin();
  }

  private void worldRenderStarted(WorldRenderContext context) {
    if (client.world == null || client.player == null || context.world() != client.world
        || lifecycle.status() == PlayerLifecycle.Status.LOADING) { renderSnapshot.invalidate(); return; }
    var camera = context.camera();
    if (!camera.isReady() || context.positionMatrix() == null || context.projectionMatrix() == null) {
      renderSnapshot.invalidate(); return;
    }
    long sampled = System.nanoTime();
    var position = camera.getPos();
    var rotation = camera.getRotation();
    context.positionMatrix().get(renderSnapshot.positionMatrix);
    context.projectionMatrix().get(renderSnapshot.projectionMatrix);
    EffectAuthority.Space space = incarnationSignals.space();
    renderSnapshot.sample(sampled, lifecycle.lifeId(), space == null ? 0 : space.epoch(),
        position.x, position.y, position.z, rotation.x(), rotation.y(), rotation.z(), rotation.w(),
        Math.toRadians(camera.getYaw()), Math.toRadians(camera.getPitch()), camera.getLastTickDelta());
  }

  public void render() {
    try {
      EffectAuthority.Space space = incarnationSignals.space();
      if (video != null) video.capture(renderSnapshot, clientTick, lifecycle.lifeId(),
          space == null ? 0 : space.epoch(), authority, incarnationSignals.screen());
      settleResidentSample(true);
    } finally {
      renderSnapshot.end();
    }
  }

  private Socket controlSocket() throws IOException {
    if (evaluationConfig == null || evaluationConfig.controlSendBufferBytes() == null)
      return new Socket(InetAddress.getLoopbackAddress(), config.get("control_port").getAsInt());
    Socket socket = new Socket();
    try {
      socket.setSendBufferSize(evaluationConfig.controlSendBufferBytes());
      socket.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), config.get("control_port").getAsInt()));
      return socket;
    } catch (IOException | RuntimeException error) {
      try { socket.close(); } catch (IOException ignored) {}
      throw error;
    }
  }

  private void control() {
    long lastDecodedRequestId = 0;
    String lastDecodedMethod = "unavailable";
    try (Socket socket = controlSocket()) {
      if (evaluationConfig != null) actualControlSendBufferBytes = socket.getSendBufferSize();
      socket.setTcpNoDelay(true);
      socket.setSoTimeout(15000);
      output = new NativeControlWriter(socket.getOutputStream(),
          () -> { try { socket.close(); } catch (IOException ignored) {} }, error -> transportFailed());
      if (!output.critical(hello(config))) throw new IOException("Native hello writer unavailable");
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
          if (requestId <= lastRequestId) throw new IOException("Invalid request sequence");
          lastRequestId = requestId;
          if (!request.get("session_id").getAsString().equals(config.get("session_id").getAsString())
              || !request.get("world_id").getAsString().equals(config.get("world_id").getAsString())
              || NativeEffectContract.counter(request, "epoch") != NativeEffectContract.counter(config, "epoch")
              || !NativeEffectContract.id(request, "native_boot_id").equals(effectAuthority.nativeBootId()))
            throw new IOException("Authority mismatch");
          long generation = NativeEffectContract.counter(request, "generation");
          long receivedNanos = System.nanoTime();
          request.addProperty("received_ns", receivedNanos);
          replyTiming.received(requestId, receivedNanos);
          String method = request.get("method").getAsString();
          lastDecodedRequestId = requestId;
          lastDecodedMethod = switch (method) {
            case "controller_submit", "controller_heartbeat", "controller_sample", "controller_revoke",
                "controller_open", "controller_frame", "cancel", "disconnect", "execute", "ping",
                "diagnostics", "evaluation_arm_inventory_replacement", "evaluation_status",
                "motor_profile", "observe", "visible_screen", "recipes" -> method;
            default -> "unrecognized";
          };
          if (method.equals("controller_submit") || method.equals("controller_heartbeat")) {
            receiveController(request);
            continue;
          }
          if (method.equals("controller_sample")) {
            try {
              requireStream(request.getAsJsonObject("params"));
            } catch (RuntimeException error) {
              reply(requestId, null, "Controller sample rejected: " + error.getMessage());
              continue;
            }
            if (!controllerSamplePending.compareAndSet(null, request)) throw new IOException("Controller sample lane occupied");
            client.execute(this::drainControllerSample);
            continue;
          }
          if (method.equals("cancel") || method.equals("disconnect") || method.equals("controller_revoke")) {
            if (!retirementReserved.compareAndSet(false, true)) throw new IOException("Retirement slot already occupied");
            JsonObject params = request.getAsJsonObject("params");
            boolean emergency = method.equals("disconnect") || params.has("emergency") && params.get("emergency").getAsBoolean();
            boolean matched;
            if (method.equals("controller_revoke")) {
              StreamOwner stream = requireStream(params);
              controllerSamples.retirementRequested(stream);
              stream.queue().fence("admission_revoked");
              if (evaluationGate != null) evaluationGate.cancel(stream.grant().owner());
              effectAuthority.close(stream.grant().owner()); authority = effectAuthority.cancellationGeneration();
              matched = true;
            } else if (emergency) { fenceAuthority(); matched = true; }
            else {
              EffectAuthority.Owner expected = NativeEffectContract.owner(params.getAsJsonObject("expected_owner"));
              matched = effectAuthority.close(expected);
              if (matched && evaluationGate != null) evaluationGate.cancel(expected);
              authority = effectAuthority.cancellationGeneration();
            }
            request.addProperty("matched_owner", matched);
            retirementReplies.put(requestId, method.equals("disconnect"));
            if (!retirementPending.compareAndSet(null, request)) throw new IOException("Retirement queue already occupied");
            client.execute(this::drainRetirement);
            continue;
          }
          if (queued.incrementAndGet() > 32) throw new IOException("Ordinary pending bound reached");
          if (method.equals("controller_open")) {
            if (streamOwner != null) throw new IOException("Prior controller retirement has not drained");
            NativeControllerContract.Grant grant = NativeControllerContract.grant(request.getAsJsonObject("params"), generation, receivedNanos);
            EffectAuthority.Rejection rejection = effectAuthority.grant(grant.owner(), grant.compatibilityHash(), grant.expectedScreen());
            if (rejection != EffectAuthority.Rejection.NONE) {
              queued.decrementAndGet(); reply(requestId, null, "Controller receive grant rejected: " + rejection.name()); continue;
            }
            ControllerInputQueue queue = new ControllerInputQueue(grant.taskDeadline(), receivedNanos);
            OpportunityTrace trace = openOpportunityTrace(grant);
            queue.bindTrace(trace.collector);
            synchronized (queue) {
              replyTiming.controllerLease(requestId, grant.owner(), grant.controllerGeneration(),
                  queue.opened(System.nanoTime()));
              streamOwner = new StreamOwner(grant, queue, trace);
            }
          }
          if (method.equals("execute")) {
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
    } catch (Exception error) {
      // Never log packets, params, parser excerpts or stack traces. These are the
      // last successfully decoded envelope fields, not a claim about the cause.
      com.mojang.logging.LogUtils.getLogger().error(
          "Native control failure: last_decoded_request_id={}, last_decoded_method={}, exception={}, message={}",
          lastDecodedRequestId, lastDecodedMethod, error.getClass().getSimpleName(), safeControlFailureMessage(error));
    } finally {
      connected = false;
      fenceAuthority();
      if (output != null) output.close();
      client.execute(
          () -> {
            neutralize();
            client.scheduleStop();
          });
    }
  }

  private static String safeControlFailureMessage(Exception error) {
    String message = error.getMessage();
    if (message == null) return "unavailable";
    // Only fixed infrastructure/contract messages are safe to retain. Arbitrary
    // Gson/JDK messages can quote request contents, filesystem paths or endpoints.
    return switch (message) {
      case "Native hello writer unavailable", "Invalid request sequence", "Authority mismatch",
          "Controller sample lane occupied", "Retirement slot already occupied", "Retirement queue already occupied",
          "Ordinary pending bound reached", "Prior controller retirement has not drained", "Control frame exceeded bound",
          "No admitted controller owner", "Controller owner or generation differs",
          "Unknown or missing controller fields", "Native time must be a signed decimal string",
          "Invalid native time digits", "Controller native cancellation generation differs",
          "Controller clock uncertainty required", "Controller time/clock authority invalid",
          "Read timed out", "Socket closed", "Connection reset", "Broken pipe" -> message;
      default -> "redacted_nonconstant_message";
    };
  }

  private void transportFailed() {
    connected = false;
    fenceAuthority();
    client.execute(() -> { neutralize(); client.scheduleStop(); });
  }

  private void drainRetirement() {
    JsonObject request = retirementPending.getAndSet(null);
    if (request != null) dispatch(request);
  }

  private void drainControllerSample() {
    JsonObject request = controllerSamplePending.getAndSet(null);
    if (request != null) dispatch(request);
  }

  private StreamOwner requireStream(JsonObject params) {
    StreamOwner stream = streamOwner;
    if (stream == null) throw new IllegalArgumentException("No admitted controller owner");
    NativeControllerContract.owner(params, stream.grant());
    return stream;
  }

  /** Called only after a real mouse press and capture of the old driver's pending release values. */
  void evaluationInventoryPressed(VisibleScreen driver, Object screen, Object handler,
      EffectAuthority.VisibleScreenRef ref, int operationIndex) {
    if (evaluationGate == null || !evaluationGate.armed() || operationIndex != 1) return;
    StreamOwner stream = streamOwner;
    if (stream == null || driver != streamGuiDriver || driver != visibleInput || !driver.evaluationPressed()
        || !streamAuthorized() || stream.queue().expired(System.nanoTime())
        || client.currentScreen != screen || !(screen instanceof InventoryScreen inventory)
        || client.player.currentScreenHandler != handler || handler != client.player.playerScreenHandler
        || inventory.getScreenHandler() != handler) return;
    try {
      if (!ref.equals(visibleView.currentLayout())) return;
    } catch (RuntimeException unavailable) { return; }
    if (!evaluationGate.consume(stream.grant().owner(), stream.grant().controllerGeneration(),
        screen, handler, ref, operationIndex)) return;
    // Consumption precedes allocation/setScreen: any exception or real scope change cannot retry.
    evaluationTriggered = true; evaluationTriggerHeld = driver.evaluationPressed();
    evaluationTriggerNanos = System.nanoTime(); evaluationReplacementStatus = "failed";
    try {
      InventoryScreen replacement = new InventoryScreen(client.player);
      client.setScreen(replacement);
      EffectAuthority.Screen identity = screenIncarnations.screen();
      if (client.currentScreen != replacement || identity == null
          || identity.id().equals(ref.id()) || identity.incarnation() == ref.incarnation()) return;
      evaluationReplacementScreen = identity;
      evaluationReplacementType = replacement.getClass().getName();
      evaluationReplacementStatus = "replaced";
    } catch (RuntimeException failed) {
      // The already-consumed fault remains failed; ordinary driver cleanup owns the old gesture.
    }
  }

  private JsonObject evaluationStatus() {
    JsonObject out = new JsonObject();
    out.addProperty("enabled", true);
    out.addProperty("allow_inventory_replacement", evaluationConfig.allowInventoryReplacement());
    out.addProperty("control_send_buffer_bytes", evaluationConfig.controlSendBufferBytes());
    out.addProperty("actual_control_send_buffer_bytes", actualControlSendBufferBytes);
    boolean armed = evaluationGate.armed(), consumed = evaluationGate.consumed();
    out.addProperty("armed", armed); out.addProperty("consumed", consumed);
    out.addProperty("replacement_status", !armed && !consumed && evaluationOwner != null ? "cancelled" : evaluationReplacementStatus);
    out.add("owner", evaluationOwner == null ? JsonNull.INSTANCE : NativeControllerContract.owner(evaluationOwner));
    if (evaluationOwner == null) out.add("controller_generation", JsonNull.INSTANCE);
    else out.addProperty("controller_generation", evaluationControllerGeneration);
    out.add("original_screen", evaluationOriginalScreen == null ? JsonNull.INSTANCE : NativeEffectContract.visibleScreen(evaluationOriginalScreen));
    out.add("replacement_screen", NativeEffectContract.screen(evaluationReplacementScreen));
    out.addProperty("original_screen_type", evaluationOriginalType);
    out.addProperty("replacement_screen_type", evaluationReplacementType);
    out.addProperty("trigger_phase", evaluationTriggered ? "pressed" : null);
    out.addProperty("trigger_held", evaluationTriggerHeld);
    if (evaluationTriggered) {
      out.addProperty("operation_index", 1);
      out.addProperty("trigger_native_ns", Long.toString(evaluationTriggerNanos));
    } else {
      out.add("operation_index", JsonNull.INSTANCE); out.add("trigger_native_ns", JsonNull.INSTANCE);
    }
    return out;
  }

  private void receiveController(JsonObject request) {
    long id = NativeEffectContract.counter(request, "id"), now = System.nanoTime();
    try {
      JsonObject params = request.getAsJsonObject("params");
      String method = NativeEffectContract.id(request, "method");
      if (method.equals("controller_heartbeat")) {
        NativeControllerContract.fields(params, Set.of("owner", "controller_generation", "deadline_native_ns"));
        StreamOwner stream = requireStream(params);
        synchronized (stream.queue()) {
          long checked = System.nanoTime();
          Long deadline = null;
          ControllerInputQueue.LeaseCheck check;
          try {
            deadline = NativeControllerContract.nanos(params, "deadline_native_ns");
            EffectAuthority.Rejection rejection = effectAuthority.validateApplication(stream.grant().owner(), stream.grant().compatibilityHash());
            if (rejection != EffectAuthority.Rejection.NONE) {
              String queueReason = stream.queue().reason();
              throw new IllegalStateException((queueReason == null ? "Controller heartbeat scope revoked" : queueReason) + ": authority=" + rejection);
            }
            check = stream.queue().heartbeat(deadline, checked);
            check.requireAccepted();
          } catch (RuntimeException error) {
            stream.queue().fence("controller_receive_failed");
            replyTiming.controllerLease(id, stream.grant().owner(), stream.grant().controllerGeneration(),
                stream.queue().refused(deadline, checked));
            throw error;
          }
          replyTiming.controllerLease(id, stream.grant().owner(), stream.grant().controllerGeneration(), check);
        }
        reply(id, new JsonObject(), null);
        return;
      }
      NativeControllerContract.fields(params, Set.of("sequence", "frame", "ordered_edge_start", "ordered_edge_end"));
      JsonObject frame = params.getAsJsonObject("frame");
      NativeControllerContract.fields(frame, Set.of("context", "input"));
      JsonObject context = frame.getAsJsonObject("context");
      NativeControllerContract.fields(context, Set.of("owner", "controller_generation", "source_hash", "frame_seq",
          "observed_native_tick", "captured_native_ns"));
      StreamOwner stream = requireStream(context);
      if (effectAuthority.validateApplication(stream.grant().owner(), stream.grant().compatibilityHash()) != EffectAuthority.Rejection.NONE
          || !NativeEffectContract.id(context, "source_hash").equals(stream.grant().owner().scope().sourceHash()))
        throw new IllegalArgumentException("Controller submitted source/scope differs");
      long sequence = NativeEffectContract.counter(context, "frame_seq"), tick = NativeEffectContract.counter(context, "observed_native_tick");
      long captured = NativeControllerContract.nanos(context, "captured_native_ns");
      CapturedControllerFrame actual;
      synchronized (controllerCaptures) { actual = controllerCaptures.get(sequence); }
      if (actual == null || actual.tick() != tick || actual.nanos() != captured
          || actual.life() != stream.grant().owner().scope().lifeId()
          || actual.space().epoch() != stream.grant().owner().scope().spaceEpoch())
        throw new IllegalArgumentException("Controller input does not name its actual permitted native capture");
      stream.queue().admit(id, NativeEffectContract.counter(params, "sequence"), sequence, tick, captured,
          NativeEffectContract.counter(params, "ordered_edge_start"), NativeEffectContract.counter(params, "ordered_edge_end"),
          frame.getAsJsonObject("input"), now);
    } catch (RuntimeException error) {
      StreamOwner stream = streamOwner;
      if (stream != null) stream.queue().fence("controller_receive_failed");
      reply(id, null, "Controller request rejected: " + error.getMessage());
    }
  }

  private boolean streamAuthorized() {
    StreamOwner stream = streamOwner;
    return stream != null && connected && client.isOnThread() && lifecycle.ready() && client.player != null
        && client.world != null && client.player.getHealth() > 0 && !client.player.isDead()
        && effectAuthority.validateApplication(stream.grant().owner(), stream.grant().compatibilityHash()) == EffectAuthority.Rejection.NONE;
  }

  private void prepareController() {
    StreamOwner stream = streamOwner;
    OpportunityTrace trace = stream == null || stream.trace().retired ? null : stream.trace();
    preparingOpportunityTrace = trace;
    opportunityHook(stream, NativePreparationTrace.Kind.PREPARE_ENTRY, NativePreparationTrace.Outcome.OBSERVED, 0, 0, 0, 0, 1);
    try {
      prepareController(stream);
    } finally {
      opportunityHook(stream, NativePreparationTrace.Kind.PREPARE_EXIT, NativePreparationTrace.Outcome.OBSERVED, 0, 0, 0, 0, 1);
      preparingOpportunityTrace = null;
      if (trace != null && trace.retired && trace.collector != null) trace.collector.seal();
    }
  }

  private void prepareController(StreamOwner stream) {
    long evaluated = 1, values = stream == null ? 0 : 1;
    boolean available = stream != null;
    if (available) {
      evaluated |= 2;
      available = streamRetirement == null;
      if (available) values |= 2;
    }
    opportunityBranch(stream, available, evaluated, values, 10);
    if (!available) return;
    long now = System.nanoTime();
    evaluated = 1; values = 0;
    boolean authorized = streamAuthorized();
    if (authorized) values |= 1;
    boolean permitted = authorized;
    if (authorized) {
      evaluated |= 2;
      permitted = !stream.queue().expired(now);
      if (permitted) values |= 2;
    }
    opportunityBranch(stream, permitted, evaluated, values, 11);
    if (!permitted) {
      retireController(stream.queue().reason() == null ? "controller_scope_changed" : stream.queue().reason());
      return;
    }
    evaluated = 1; values = 0;
    permitted = streamInputs != null;
    if (permitted) {
      values |= 1; evaluated |= 2;
      permitted = visibleInput == null;
      if (permitted) {
        values |= 2; evaluated |= 4;
        permitted = !client.isPaused();
        if (permitted) {
          values |= 4; evaluated |= 8;
          permitted = client.getOverlay() == null;
          if (permitted) values |= 8;
        }
      }
    }
    opportunityBranch(stream, permitted, evaluated, values, 12);
    if (!permitted) return;
    ControllerInputQueue.Entry entry = stream.queue().begin(now, clientTick);
    if (entry != null) {
      try {
        if (entry.world() != null) {
          if (client.currentScreen != null) throw new IllegalStateException("World stream input requires absent screen");
          streamInputs.begin(entry);
        } else {
          streamInputs.screenChanged();
          incarnationSignals.viewReceived();
          streamGuiEntry = entry;
          if (entry.edgeEnd() == entry.edgeStart()) {
            if (!NativeEffectContract.visibleScreen(entry.screenAction().getAsJsonObject("screen")).equals(visibleView.currentLayout()))
              throw new IllegalStateException("Empty GUI snapshot layout changed");
            completeControllerGui(entry, 0, now, true, null);
          } else {
            streamGuiDriver = visibleInput = new VisibleScreen(client, visibleView, entry.screenAction(), authority, now,
              effectAuthority.nativeBootId(), () -> streamAuthorized() && !stream.queue().expired(System.nanoTime()),
              this::nextReceiptNonce, (prefix, appliedAt) -> {
                if (prefix == entry.edgeEnd() - entry.edgeStart())
                  completeControllerGui(entry, prefix, appliedAt, true, null);
              }, outcome -> {
                visibleInput = null; streamGuiDriver = null;
                JsonObject evidence = outcome.getAsJsonObject("evidence");
                if (streamGuiEntry == entry)
                  completeControllerGui(entry, evidence.get("applied_prefix").getAsInt(), System.nanoTime(), false,
                      evidence.get("stop_reason").getAsString());
                publishControllerEffect(stream, entry.sequence(), outcome);
              });
            if (evaluationConfig != null && evaluationConfig.allowInventoryReplacement()) streamGuiDriver.evaluation(this);
          }
        }
      } catch (RuntimeException error) {
        stream.queue().fence("controller_application_rejected: " + error.getMessage());
        retireController(stream.queue().reason());
        return;
      }
    }
    boolean unfenced = !stream.queue().fenced();
    opportunityBranch(stream, unfenced, 1, unfenced ? 1 : 0, 14);
    if (!unfenced) { retireController(stream.queue().reason()); return; }
    evaluated = 1; values = 0;
    boolean prepared = streamInputs != null;
    if (prepared) {
      values |= 1; evaluated |= 2;
      prepared = client.currentScreen == null;
      if (prepared) {
        values |= 2; evaluated |= 4;
        prepared = streamInputs.prepare(clientTick);
        if (prepared) values |= 4;
      }
    }
    opportunityBranch(stream, prepared, evaluated, values, 13);
    if (prepared)
      stream.queue().applicationStage(streamInputs.pending(), 1, System.nanoTime());
  }

  /**
   * Stable hook legend; value bits are positive production conditions, meaningful only if evaluated.
   * PREPARE 1 brackets the invocation (cursor before/after actual queue.begin; it never advances it).
   * 10: owner present, no retirement; 11: streamAuthorized, not expired;
   * 12: inputs present, no visible driver, not paused, no overlay;
   * 14: queue not fenced; 13: inputs present, no screen, actual inputs.prepare returned true.
   * SAMPLE 20: rendered, read present; 21: deadline live, same owner, no retirement,
   * inputs present, streamAuthorized, not expired (in original short-circuit order);
   * 23: actual residentReadCurrent returned true;
   * 22: actual visibleView.ready (only after phase.ready); 24: original capture succeeded;
   * 25: actual post-capture residentReadCurrent, actual phase.sampled; 26: caught capture failure.
   * Sequence is unknown for these hooks; request identifies the actual pending read, and frame is
   * unknown until the original capture succeeds. No helper evaluates any production predicate.
   */
  private void opportunityHook(StreamOwner stream, NativePreparationTrace.Kind kind,
      NativePreparationTrace.Outcome outcome, long request, long frame, long evaluated, long values, int stage) {
    if (stream == null || stream.trace().collector == null || stream.trace().retired && preparingOpportunityTrace != stream.trace()) return;
    stream.trace().collector.hook(kind, outcome, System.nanoTime(), clientTick,
        stream.queue().preparationOrdinal(), request, 0, frame, evaluated, values, stage);
  }

  private void opportunityBranch(StreamOwner stream, boolean passed, long evaluated, long values, int stage) {
    opportunityHook(stream, NativePreparationTrace.Kind.PREPARE_BRANCH,
        passed ? NativePreparationTrace.Outcome.PASSED : NativePreparationTrace.Outcome.BLOCKED,
        0, 0, evaluated, values, stage);
  }

  private void completeControllerGui(ControllerInputQueue.Entry entry, int prefix, long now, boolean confirmed, String reason) {
    StreamOwner stream = streamOwner;
    if (stream == null || streamGuiEntry != entry || streamInputs == null || client.player == null) return;
    streamGuiEntry = null;
    JsonObject ack = streamInputs.ack(stream.grant().controllerGeneration(), entry.sequence(),
        entry.edgeStart() + prefix, clientTick, now, confirmed ? "confirmed" : "partial", reason);
    completeControllerInput(stream, entry, ack);
  }

  private void completeControllerInput(StreamOwner stream, ControllerInputQueue.Entry entry, JsonObject ack) {
    var application = stream.queue().complete(entry, NativeEffectContract.counter(ack, "ordered_edge_prefix"),
        NativeEffectContract.counter(ack, "applied_native_tick"), NativeControllerContract.nanos(ack, "applied_native_ns"));
    replyTiming.controllerApplication(entry.requestId(), stream.grant().owner(), stream.grant().controllerGeneration(), application);
    if (lifecycle.ready() && stream.grant().owner().scope().lifeId() == lifecycle.lifeId()
        && incarnationSignals.space() != null
        && stream.grant().owner().scope().spaceEpoch() == incarnationSignals.space().epoch()) lastStreamAck = ack;
    reply(entry.requestId(), ack, null);
    if (!ack.get("input_application").getAsString().equals("confirmed")) stream.queue().fence("partial_input_application");
  }

  private void publishControllerEffect(StreamOwner stream, long sequence, JsonObject result) {
    JsonObject event = new JsonObject(), message = new JsonObject();
    event.add("owner", NativeControllerContract.owner(stream.grant().owner()));
    event.addProperty("controller_generation", stream.grant().controllerGeneration());
    event.addProperty("sequence", sequence); event.addProperty("recorded_native_ns", Long.toString(System.nanoTime()));
    event.add("result", result);
    JsonObject projected = new JsonObject();
    projected.addProperty("controller_generation", stream.grant().controllerGeneration());
    projected.addProperty("sequence", sequence); projected.add("recorded_native_ns", event.get("recorded_native_ns"));
    projected.add("result", result);
    int bytes = utf8Length(projected.toString());
    boolean currentScope = lifecycle.ready() && stream.grant().owner().scope().lifeId() == lifecycle.lifeId()
        && incarnationSignals.space() != null
        && stream.grant().owner().scope().spaceEpoch() == incarnationSignals.space().epoch();
    if (currentScope && bytes <= 16382) {
      while (controllerEffects.size() == 8 || controllerEffectBytes + bytes + controllerEffects.size() + 2 > 16384) {
        controllerEffectBytes -= controllerEffects.removeFirst().bytes();
        controllerEffectsOmitted = ContractIdentity.next(controllerEffectsOmitted);
      }
      controllerEffects.addLast(new ControllerEffect(projected, bytes)); controllerEffectBytes += bytes;
    } else if (currentScope) controllerEffectsOmitted = ContractIdentity.next(controllerEffectsOmitted);
    message.add("controller_effect", event);
    output.critical(message.toString());
  }

  private static int utf8Length(String value) {
    int bytes = 0;
    for (int index = 0; index < value.length(); index++) {
      char unit = value.charAt(index);
      if (unit < 0x80) bytes++;
      else if (unit < 0x800) bytes += 2;
      else if (Character.isHighSurrogate(unit) && index + 1 < value.length() && Character.isLowSurrogate(value.charAt(index + 1))) {
        bytes += 4; index++;
      } else bytes += Character.isSurrogate(unit) ? 1 : 3;
    }
    return bytes;
  }

  private void retireController(String reason) {
    StreamOwner stream = streamOwner;
    if (stream == null || streamRetirement != null) return;
    synchronized (stream.queue()) {
      streamRetirementLease = stream.queue().retired(reason, System.nanoTime());
    }
    if (evaluationGate != null) evaluationGate.cancel(stream.grant().owner());
    effectAuthority.close(stream.grant().owner()); authority = effectAuthority.cancellationGeneration();
    if (streamGuiDriver != null) streamGuiDriver.cancel();
    if (streamInputs != null) streamInputs.release();
    streamInputs = null;
    controllerSamples.revoke(stream);
    JsonObject ack = new JsonObject();
    ack.add("owner", NativeControllerContract.owner(stream.grant().owner()));
    ack.addProperty("controller_generation", stream.grant().controllerGeneration());
    ack.addProperty("admission_revoked", true); ack.addProperty("last_applied_sequence", stream.queue().appliedSequence());
    ack.addProperty("ordered_edge_prefix", stream.queue().edgePrefix());
    ack.addProperty("retirement_applied_native_tick", clientTick);
    ack.addProperty("retirement_applied_native_ns", Long.toString(System.nanoTime()));
    ack.addProperty("input_application", "confirmed");
    JsonArray unresolved = new JsonArray();
    unresolved.add(stream.grant().owner().operationId());
    ack.add("unresolved_operation_refs", unresolved);
    streamRetirement = ack;
    // Physical release and the genuine ACK timestamp above precede passive detachment.
    stream.queue().bindTrace(null);
    controllerSamples.bindTrace(stream, null);
    stream.trace().retired = true;
    if (stream.trace().collector != null && preparingOpportunityTrace != stream.trace())
      stream.trace().collector.seal();
    opportunityRetirementDraining = true;
    try {
      ControllerInputQueue.Entry pending;
      while ((pending = stream.queue().drain()) != null)
        reply(pending.requestId(), null, "Controller retired without confirmed application: " + reason);
    } finally {
      opportunityRetirementDraining = false;
    }
  }

  private void recordControllerRetirement(long requestId) {
    StreamOwner stream = streamOwner;
    if (stream != null && streamRetirementLease != null)
      replyTiming.controllerLease(requestId, stream.grant().owner(), stream.grant().controllerGeneration(),
          streamRetirementLease);
  }

  private synchronized OpportunityTrace openOpportunityTrace(NativeControllerContract.Grant grant) {
    NativePreparationTrace.Identity identity = new NativePreparationTrace.Identity(grant.owner().operationId(),
        grant.controllerGeneration(), effectAuthority.nativeBootId(), grant.owner().scope().sourceHash());
    OpportunityTrace trace = new OpportunityTrace(identity, opportunityTraces.size() < 4
        ? new NativePreparationTrace(identity, 4096) : null);
    if (trace.collector != null) opportunityTraces.addLast(trace);
    else unavailableOpportunityTrace = trace;
    return trace;
  }

  private static JsonObject unavailableOpportunityTrace(OpportunityTrace trace, String reason) {
    JsonObject result = new JsonObject(), identity = new JsonObject();
    result.addProperty("schema_version", 1);
    identity.addProperty("owner_operation_id", trace.identity.ownerOperationId());
    identity.addProperty("controller_generation", Long.toString(trace.identity.controllerGeneration()));
    identity.addProperty("native_boot_id", trace.identity.nativeBootId());
    identity.addProperty("source_hash", trace.identity.sourceHash());
    result.add("identity", identity); result.add("counts", JsonNull.INSTANCE);
    result.addProperty("final_batch", false); result.addProperty("complete", false);
    result.add("events", new JsonArray()); result.addProperty("unavailable", reason);
    return result;
  }

  // Called only while holding existing reply synchronization, never by a producer.
  private OpportunityTrace attachOpportunityTrace(JsonObject timing) {
    if (unavailableOpportunityTrace != null) {
      OpportunityTrace trace = unavailableOpportunityTrace;
      timing.add("controller_opportunities", unavailableOpportunityTrace(trace, "owner_capacity"));
      return trace;
    }
    OpportunityTrace trace = opportunityTraces.peekFirst();
    if (trace == null) return null;
    if (trace.serializationUnavailablePending) {
      timing.add("controller_opportunities", unavailableOpportunityTrace(trace, "serialization_oversize"));
      return trace;
    }
    if (trace.committed != null) {
      if (!trace.collector.acknowledge(trace.committed)) {
        timing.add("controller_opportunities", unavailableOpportunityTrace(trace, "committed_prefix_pending"));
        return trace;
      }
      boolean terminal = trace.committed.finalBatch()
          && trace.committed.counts().retained() == trace.committed.events().size();
      trace.committed = trace.pending = null;
      if (terminal) {
        opportunityTraces.removeFirst();
        trace = opportunityTraces.peekFirst();
        if (trace == null) return null;
      }
    }
    // Keep the seal guard and batch choice on the same retirement observation.
    boolean retired = trace.retired;
    if (retired && preparingOpportunityTrace == trace) {
      timing.add("controller_opportunities", unavailableOpportunityTrace(trace, "seal_pending"));
      return trace;
    }
    if (trace.pending == null)
      trace.pending = retired ? trace.collector.finalBatch()
          : trace.collector.batch(NativePreparationTrace.MAX_BATCH);
    timing.add("controller_opportunities", trace.pending == null
        ? unavailableOpportunityTrace(trace, "busy") : trace.pending.wire());
    return trace;
  }

  private void opportunityTraceCommitted(OpportunityTrace trace, boolean batchAttached) {
    if (trace.serializationUnavailablePending) {
      trace.serializationUnavailablePending = false;
      return;
    }
    if (trace == unavailableOpportunityTrace) {
      unavailableOpportunityTrace = null;
      return;
    }
    if (!batchAttached || trace.pending == null) return;
    trace.committed = trace.pending;
    if (trace.collector.acknowledge(trace.committed)) {
      boolean terminal = trace.committed.finalBatch()
          && trace.committed.counts().retained() == trace.committed.events().size();
      trace.committed = trace.pending = null;
      if (terminal) opportunityTraces.removeFirst();
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
    JsonObject timing = replyTiming.replied(id, effectAuthority.nativeBootId(), System.nanoTime(), clientTick);
    if (timing != null) response.add("timing", timing);
    Boolean stop = retirementReplies.remove(id);
    if (stop == null) {
      OpportunityTrace trace = timing == null || opportunityRetirementDraining
          ? null : attachOpportunityTrace(timing);
      String line = response.toString();
      boolean batchAttached = trace != null && trace.pending != null && trace.committed == null
          && !timing.getAsJsonObject("controller_opportunities").has("unavailable");
      if (trace != null && utf8Length(line) >= 131072) {
        timing.add("controller_opportunities", unavailableOpportunityTrace(trace, "serialization_oversize"));
        batchAttached = false;
        line = response.toString();
        if (utf8Length(line) >= 131072) {
          // Do not turn a valid original reply into a control failure for diagnostics.
          // Preserve the unavailable marker for the next existing ordinary carrier too.
          trace.serializationUnavailablePending = true;
          timing.remove("controller_opportunities");
          line = response.toString();
        }
      }
      if (output.critical(line) && trace != null && timing.has("controller_opportunities"))
        opportunityTraceCommitted(trace, batchAttached);
    }
    else output.reserved(response.toString(), () -> {
      retirementReserved.set(false);
      if (stop) client.execute(client::scheduleStop);
    });
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
    if (output.critical(message.toString()))
      lastPublishedCanRespawn = publishedLife.get("can_respawn").getAsBoolean();
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
    renderSnapshot.invalidate();
    resetSensingScope();
    deathNotified = lifecycle.lifeId();
    effectAuthority.lifeChanged(lifecycle.lifeId());
    authority = effectAuthority.cancellationGeneration();
    // Fence locally before publishing the authoritative cause. It must precede generic action loss.
    applyInput();
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
        if (matched) { neutralize(); recordControllerRetirement(id); }
        JsonObject result = new JsonObject();
        result.addProperty("neutralized", true);
        result.addProperty("matched_owner", matched);
        result.addProperty("generation", authority);
        result.add("session_id", config.get("session_id"));
        result.addProperty("life_id", lifecycle.lifeId());
        reply(id, result, null);
        return;
      }
      if (method.equals("controller_revoke")) {
        StreamOwner stream = requireStream(request.getAsJsonObject("params"));
        retireController("admission_revoked");
        recordControllerRetirement(id);
        JsonObject result = new JsonObject(); result.add("ack", streamRetirement);
        result.addProperty("generation", authority);
        reply(id, result, null);
        controllerSamples.retirementReplied(stream);
        streamOwner = null; streamRetirement = null; streamRetirementLease = null; streamGuiEntry = null;
        settleResidentSample(false);
        return;
      }
      if (method.equals("disconnect")) {
        neutralize();
        recordControllerRetirement(id);
        reply(id, new JsonObject(), null);
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
      if (method.equals("evaluation_arm_inventory_replacement")) {
        if (evaluationConfig == null || !evaluationConfig.allowInventoryReplacement())
          throw new IllegalStateException("Native inventory evaluation is disabled");
        JsonObject params = request.getAsJsonObject("params");
        NativeControllerContract.fields(params, Set.of("owner", "controller_generation", "screen"));
        StreamOwner stream = requireStream(params);
        if (!streamAuthorized() || stream.queue().expired(System.nanoTime()) || streamInputs == null
            || visibleInput != null || VisibleScreen.owned() || VisibleInventory.owned()
            || motor != null || ordinaryInput != null || client.getOverlay() != null
            || !(client.currentScreen instanceof InventoryScreen inventory)
            || !(client.player.currentScreenHandler instanceof net.minecraft.screen.PlayerScreenHandler)
            || client.player.currentScreenHandler != client.player.playerScreenHandler
            || inventory.getScreenHandler() != client.player.playerScreenHandler)
          throw new IllegalStateException("No live idle own-inventory controller view");
        EffectAuthority.VisibleScreenRef ref = NativeEffectContract.visibleScreen(params.getAsJsonObject("screen"));
        if (!ref.equals(visibleView.currentLayout())
            || !evaluationGate.arm(stream.grant().owner(), stream.grant().controllerGeneration(),
                inventory, inventory.getScreenHandler(), ref))
          throw new IllegalStateException("Native inventory evaluation arm rejected");
        evaluationOwner = stream.grant().owner(); evaluationControllerGeneration = stream.grant().controllerGeneration();
        evaluationOriginalScreen = ref; evaluationOriginalType = inventory.getClass().getName();
        evaluationReplacementStatus = "armed";
        reply(id, evaluationStatus(), null);
        return;
      }
      if (method.equals("evaluation_status")) {
        if (evaluationConfig == null) throw new IllegalStateException("Native evaluation is disabled");
        NativeControllerContract.fields(request.getAsJsonObject("params"), Set.of());
        reply(id, evaluationStatus(), null);
        return;
      }
      if (method.equals("motor_profile")) {
        if (motor != null || ordinaryInput != null || visibleInput != null || respawnRequest != 0 || effectAuthority.owner() != null) {
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
      if (method.equals("controller_open")) {
        StreamOwner stream = streamOwner;
        if (stream == null || !streamAuthorized() || stream.queue().expired(System.nanoTime())
            || motor != null || ordinaryInput != null || visibleInput != null)
          throw new IllegalStateException("Controller game-thread grant is unavailable");
        streamInputs = new StreamInputs(client); lastStreamAck = streamRetirement = null; streamRetirementLease = null;
        controllerSamples.open(stream, clientTick);
        controllerSamples.bindTrace(stream, stream.trace().collector);
        JsonObject result = new JsonObject();
        result.add("owner", NativeControllerContract.owner(stream.grant().owner()));
        result.addProperty("controller_generation", stream.grant().controllerGeneration());
        reply(id, result, null); return;
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
      if (method.equals("visible_screen")) {
        if (!request.getAsJsonObject("params").keySet().isEmpty()) {
          reply(id, null, "Visible screen read takes no arguments");
          return;
        }
        incarnationSignals.viewReceived();
        if (!visibleView.ready()) {
          if (pendingGuiReads.size() >= 16) reply(id, null, "Visible screen read bound reached");
          else pendingGuiReads.put(id, request.get("received_ns").getAsLong() + 2_000_000_000L);
          return;
        }
        reply(id, visibleView.snapshot(), null);
        return;
      }
      if (method.equals("controller_frame") || method.equals("controller_sample")) {
        JsonObject params = request.getAsJsonObject("params");
        StreamOwner sampleOwner = null;
        if (method.equals("controller_sample")) {
          NativeControllerContract.fields(params, Set.of("owner", "controller_generation", "audio_cursor"));
          sampleOwner = requireStream(params);
        } else if (!params.keySet().equals(Set.of("audio_cursor"))) throw new IllegalArgumentException("Controller frame requires one audio_cursor");
        SoundProjection.Cursor cursor = controllerCursor(params.get("audio_cursor"));
        incarnationSignals.viewReceived();
        if (sampleOwner != null) {
          if (!streamAuthorized() || streamInputs == null || streamRetirement != null || sampleOwner.queue().expired(System.nanoTime()))
            throw new IllegalStateException("Resident sample owner is unavailable");
          if (pendingResidentRead != null || pendingControllerReads.size() >= 4)
            reply(id, null, "Controller frame rendered-source read bound reached");
          else pendingResidentRead = new ResidentRead(id, cursor, request.get("received_ns").getAsLong() + 2_000_000_000L, sampleOwner);
          return;
        }
        if (!visibleView.ready()) {
          if (pendingControllerReads.size() + (pendingResidentRead == null ? 0 : 1) >= 4)
            reply(id, null, "Controller frame rendered-source read bound reached");
          else pendingControllerReads.put(id, new ControllerRead(cursor, request.get("received_ns").getAsLong() + 2_000_000_000L));
          return;
        }
        reply(id, controllerFrame(cursor), null);
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
        if (respawnRequest != 0 || motor != null || ordinaryInput != null || visibleInput != null || lifecycle.status() != PlayerLifecycle.Status.DEAD) {
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
      if (motor != null || ordinaryInput != null || visibleInput != null) {
        reply(id, result("failed", "An effect owner is already active", false), null);
        return;
      }
      if (client.player.isDead()) {
        reply(id, result("failed", "Player is dead", false), null);
        return;
      }
      if (received.worldInput() != null) {
        if (!received.expectedScreen().kind().equals("absent") || client.currentScreen != null) {
          reply(id, rejectedEffect("game_thread", "World input requires no open screen"), null);
          return;
        }
        ordinaryInput = new NativeInputs(client, id, received, request.get("received_ns").getAsLong());
        if (ordinaryInput.expired(System.nanoTime())) finishOrdinary("expired");
        return;
      }
      if (action.get("kind").getAsString().equals("screen_input")) {
        incarnationSignals.viewReceived();
        visibleInput = new VisibleScreen(client, visibleView, action, authority,
            request.get("received_ns").getAsLong(), effectAuthority.nativeBootId(),
            () -> connected && client.isOnThread() && lifecycle.ready() && client.player != null
                && client.world != null && client.player.getHealth() > 0 && !client.player.isDead()
                && effectAuthority.validateApplication(received.owner(), received.compatibilityHash()) == EffectAuthority.Rejection.NONE,
            this::nextReceiptNonce, (prefix, appliedAt) -> {}, outcome -> { visibleInput = null; reply(id, outcome, null); });
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
    m.addProperty("native_client_tick", clientTick);
    m.addProperty("game_renderer_render_invocation", renderSnapshot.invocation());
    m.add("life", life());
    m.addProperty("motor_profile", motorProfile.name().toLowerCase(Locale.ROOT));
    m.addProperty("screen_type", client.currentScreen == null ? null : client.currentScreen.getClass().getName());
    m.addProperty("overlay_present", client.getOverlay() != null);
    // Pinned 1.21.4 MinecraftClient.tick calls handleInputEvents only under these two conditions.
    // This is callback eligibility, not proof of consumption or permission to actuate a GUI.
    m.addProperty("world_input_events_ready", client.getOverlay() == null && client.currentScreen == null);
    m.add("visible_gui", VisibleScreen.diagnostics());
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
    NativeInputs diagnosticInput = ordinaryInput != null ? ordinaryInput : lastOrdinaryInput;
    if (diagnosticInput != null) m.add("ordinary_input", diagnosticInput.diagnostics());
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
    m.addProperty("camera_integration_clock", ordinaryInput == null && streamInputs == null ? "client_tick_monotonic_assisted" : "client_simulation_tick_0.05_seconds");
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
    m.addProperty("owned_input_cursor_locked", client.mouse.isCursorLocked());
    if (client.getWindow() != null) {
      long window = client.getWindow().getHandle();
      m.addProperty(
          "owned_window_glfw_control_pressed",
          org.lwjgl.glfw.GLFW.glfwGetKey(window, org.lwjgl.glfw.GLFW.GLFW_KEY_LEFT_CONTROL)
              == org.lwjgl.glfw.GLFW.GLFW_PRESS);
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
    JsonObject world = controllerWorld.observe(observationStarted, lifecycle.lifeId(),
        incarnationSignals.space(), incarnationSignals.screen());
    JsonObject o = new JsonObject(), data = new JsonObject();
    o.addProperty("schema_version", 3);
    o.add("world_id", config.get("world_id"));
    o.add("epoch", config.get("epoch"));
    o.add("session_id", config.get("session_id"));
    o.add("life", life());
    o.addProperty("native_boot_id", effectAuthority.nativeBootId());
    o.add("space", NativeEffectContract.space(incarnationSignals.space()));
    o.add("screen", NativeEffectContract.screen(incarnationSignals.screen()));
    o.add("observation_seq", world.get("observation_seq"));
    o.add("captured_at", world.get("captured_at"));
    JsonObject profile = descriptor.getAsJsonObject("observation").getAsJsonObject("profile");
    o.add("profile_id", profile.get("id"));
    o.add("profile_configuration_hash", profile.get("configuration_hash"));
    o.addProperty("compatibility_hash", compatibilityHash);
    o.add("data", data);
    data.add("player", player());
    data.add("blocks", world.get("blocks"));
    data.add("entities", world.get("entities"));
    JsonArray heard = new JsonArray();
    for (SoundProjection.Group group : sounds.recent(System.nanoTime())) {
      JsonObject sound = new JsonObject();
      sound.addProperty("category", SOUND_CATEGORIES[group.category()]);
      sound.addProperty("direction", SOUND_DIRECTIONS[group.direction()]);
      sound.addProperty("distance", SOUND_BANDS[group.distance()]);
      sound.addProperty("observed_at", Instant.ofEpochMilli(group.wallMillis()).toString());
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

  private JsonObject acquirePermittedWorld(long acquiredAt) {
    String now = Instant.now().toString();
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
    JsonObject world = new JsonObject();
    world.addProperty("source", "last_authorized_observation");
    observationSeq = ContractIdentity.next(observationSeq);
    world.addProperty("observation_seq", observationSeq);
    world.addProperty("captured_at", now);
    world.addProperty("captured_native_ns", Long.toString(acquiredAt));
    world.add("blocks", visible); world.add("entities", seenEntities);
    return world;
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
    e.addProperty("neutralized", motor == null && ordinaryInput == null && visibleInput == null);
    e.add("session_id", config.get("session_id"));
    e.addProperty("life_id", lifecycle.lifeId());
    if (client.player != null) e.add("player", player());
    r.add("evidence", e);
    return r;
  }

  private void tick() {
    clientTick = ContractIdentity.next(clientTick);
    drainRetirement();
    if (!connected) {
      neutralize();
      return;
    }
    StreamOwner stream = streamOwner;
    if (stream != null && streamRetirement == null && stream.queue().expired(System.nanoTime()))
      retireController(stream.queue().reason());
    settleGuiReads();
    settleControllerReads();
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
    if (visibleInput != null) visibleInput.tick();
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

  private boolean ordinaryAuthorized() {
    return ordinaryInput != null && connected && client.isOnThread()
        && client.player != null && client.world != null && lifecycle.ready()
        && client.player.getHealth() > 0 && !client.player.isDead()
        && effectAuthority.validateApplication(ordinaryInput.received.owner(),
            ordinaryInput.received.compatibilityHash(), EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE;
  }

  private boolean checkOrdinary() {
    if (ordinaryInput == null) return false;
    if (client.currentScreen != null) ordinaryInput.screenChanged(clientTick);
    if (ordinaryInput.screenOpened()) return false;
    if (ordinaryInput.expired(System.nanoTime())) { finishOrdinary("expired"); return false; }
    if (!ordinaryAuthorized()) { finishOrdinary("stale"); return false; }
    return true;
  }

  /** Pinned tick bytecode updates the crosshair before handleInputEvents. */
  public void beforeCrosshair() {
    drainRetirement();
    prepareController();
    if (ordinaryInput != null && checkOrdinary() && !client.isPaused() && client.getOverlay() == null)
      ordinaryInput.prepare(clientTick, System.nanoTime());
    if (motor != null) motor.rotate();
  }

  public void ordinaryConsumptionStarted() {
    if (streamInputs != null && streamCanConsume())
      streamInputs.beginConsumption();
    if (checkOrdinary()) ordinaryInput.beginConsumption(clientTick);
  }

  public void ordinaryConsumptionEnded() {
    if (streamInputs != null && streamInputs.endConsumption())
      streamOwner.queue().applicationStage(streamInputs.pending(), 2, System.nanoTime());
    if (ordinaryInput != null) ordinaryInput.endConsumption(clientTick);
  }

  public boolean ordinaryAttackEntry() {
    if (streamInputs != null) return streamCanConsume() && client.currentScreen == null;
    if (ordinaryInput == null) return true;
    if (!checkOrdinary()) return false;
    ordinaryInput.attackEntry();
    return true;
  }

  public boolean ordinaryUseEntry() {
    if (streamInputs != null) return streamCanConsume() && client.currentScreen == null;
    if (ordinaryInput == null) return true;
    if (!checkOrdinary()) return false;
    ordinaryInput.useEntry();
    return true;
  }

  public boolean ordinaryBlockEntry() {
    if (streamInputs != null) return streamCanConsume() && client.currentScreen == null;
    return ordinaryInput == null || checkOrdinary();
  }

  public boolean ownedWorldCursor() {
    if (streamInputs != null) return streamAuthorized() && !streamOwner.queue().expired(System.nanoTime()) && client.currentScreen == null;
    return ordinaryAuthorized() && !ordinaryInput.screenOpened()
        && !ordinaryInput.expired(System.nanoTime()) && client.currentScreen == null;
  }

  public boolean ownedWorldModifier() {
    if (streamInputs != null) return ownedWorldCursor() && streamInputs.consuming();
    return ownedWorldCursor() && ordinaryInput.consuming();
  }

  public boolean ownedWorldDropAll() {
    return ownedWorldModifier() && (streamInputs != null ? streamInputs.dropAll() : ordinaryInput.dropAll());
  }

  public void streamKeyConsumed(net.minecraft.client.option.KeyBinding key) {
    if (client.isOnThread() && streamInputs != null) streamInputs.keyConsumed(key);
  }
  public void beforeStreamKeyConsumption() {
    if (client.isOnThread() && streamInputs != null) streamCanConsume();
  }
  private boolean streamCanConsume() {
    StreamOwner stream = streamOwner;
    if (stream == null || streamInputs == null) return false;
    long now = System.nanoTime();
    ControllerInputQueue.Entry pending = streamInputs.pending();
    if (!streamAuthorized() || stream.queue().expired(now) ||
        pending != null && (now < pending.capturedNanos() || now - pending.capturedNanos() > ControllerInputQueue.FRAME_AGE_NS)) {
      retireController("controller_input_expired_before_vanilla_consumption");
      return false;
    }
    return true;
  }

  private void inputTickEnded() {
    if (streamInputs != null && streamOwner != null) {
      StreamOwner stream = streamOwner;
      ControllerInputQueue.Entry pending = streamInputs.pending();
      JsonObject ack = streamInputs.settle(stream.grant().controllerGeneration(), clientTick, System.nanoTime());
      if (ack != null) completeControllerInput(stream, pending, ack);
    }
    publishControllerProgress();
    // Life/space notices from this tick precede a pending read failure.
    settleResidentSample(false);
    if (ordinaryInput == null) return;
    boolean complete = ordinaryInput.settle(clientTick);
    if (ordinaryInput.screenOpened()) finishOrdinary("screen_opened");
    else if (complete) finishOrdinary("completed");
    else checkOrdinary();
  }

  private void publishControllerProgress() {
    StreamOwner stream = streamOwner;
    if (stream == null || streamRetirement != null || !connected) return;
    JsonObject progress = new JsonObject(), message = new JsonObject();
    progress.add("owner", NativeControllerContract.owner(stream.grant().owner()));
    progress.addProperty("controller_generation", stream.grant().controllerGeneration());
    progress.addProperty("sequence", stream.queue().appliedSequence());
    progress.addProperty("native_tick", clientTick); progress.addProperty("captured_native_ns", Long.toString(System.nanoTime()));
    progress.addProperty("telemetry_omitted", output.telemetryOmitted());
    message.add("controller_progress", progress);
    output.telemetry(message.toString());
  }

  private void finishOrdinary(String reason) {
    NativeInputs finished = ordinaryInput;
    if (finished == null) return;
    // Retain this owner during actual vanilla release so its emitted packet is attributed.
    JsonObject outcome = finished.finish(reason, clientTick, effectAuthority.nativeBootId());
    ordinaryInput = null;
    lastOrdinaryInput = finished;
    reply(finished.requestId, outcome, null);
  }

  public void keyboardInputStarted() {
    applyInput();
    keyboardSamplingOwner = motor;
    ordinarySamplingOwner = ordinaryInput;
  }

  public void keyboardInputSampled(boolean pressed) {
    if (streamInputs != null && streamInputs.sampled())
      streamOwner.queue().applicationStage(streamInputs.pending(), 4, System.nanoTime());
    Motor sampledOwner = keyboardSamplingOwner;
    keyboardSamplingOwner = null;
    if (pressed && sampledOwner != null && motor == sampledOwner)
      sampledOwner.inputTiming.keySample.record(System.nanoTime(), clientTick);
    NativeInputs ordinary = ordinarySamplingOwner;
    ordinarySamplingOwner = null;
    if (ordinary != null && ordinaryInput == ordinary) ordinary.keySample(clientTick, pressed);
  }

  public void applyInput() {
    applyInput(motor);
  }

  private int keyMask() {
    var o = client.options;
    return (o.forwardKey.isPressed() ? 1 : 0) | (o.backKey.isPressed() ? 2 : 0)
        | (o.leftKey.isPressed() ? 4 : 0) | (o.rightKey.isPressed() ? 8 : 0)
        | (o.jumpKey.isPressed() ? 16 : 0) | (o.sprintKey.isPressed() ? 32 : 0)
        | (o.sneakKey.isPressed() ? 64 : 0);
  }

  private void applyInput(Motor releaseOwner) {
    if (!managed() || client.options == null) return;
    if (streamInputs != null) {
      if (streamAuthorized() && !streamOwner.queue().expired(System.nanoTime())) {
        if (client.currentScreen == null) streamInputs.applyHeld();
        return;
      }
      retireController("stream_input_authority_unavailable");
    }
    if (ordinaryInput != null) {
      if (checkOrdinary()) { ordinaryInput.applyHeld(); return; }
    }
    var o = client.options;
    int before = keyMask();
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
    if (releaseOwner != null && (before & ~keyMask()) != 0)
      releaseOwner.inputTiming.keyRelease.record(System.nanoTime(), clientTick);
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
    retireController("native_neutralization");
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
    for (long id : pendingGuiReads.keySet()) reply(id, null, "Visible screen read authority fenced");
    pendingGuiReads.clear();
    rejectControllerReads("Controller frame authority fenced");
    if (ordinaryInput != null) finishOrdinary("cancelled");
    if (visibleInput != null) visibleInput.cancel();
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
  private void settleGuiReads() {
    var pending = pendingGuiReads.entrySet().iterator();
    while (pending.hasNext()) {
      var entry = pending.next();
      if (System.nanoTime() >= entry.getValue()) {
        long id = entry.getKey(); pending.remove(); reply(id, null, "Visible screen rendered-source timeout");
      } else if (visibleView.ready()) {
        long id = entry.getKey(); pending.remove();
        try { incarnationSignals.viewReceived(); reply(id, visibleView.snapshot(), null); }
        catch (RuntimeException error) { reply(id, null, "Visible screen projection rejected: " + error.getMessage()); }
      }
    }
  }

  private static SoundProjection.Cursor controllerCursor(JsonElement value) {
    if (value == null) throw new IllegalArgumentException("audio_cursor is required");
    if (value.isJsonNull()) return null;
    JsonObject cursor = value.getAsJsonObject();
    if (!cursor.keySet().equals(Set.of("stream_id", "sequence"))) throw new IllegalArgumentException("Invalid audible cursor fields");
    return new SoundProjection.Cursor(NativeEffectContract.id(cursor, "stream_id"), NativeEffectContract.counter(cursor, "sequence"));
  }

  private void resetSensingScope() {
    controllerWorld.invalidate();
    sounds.clear();
    synchronized (controllerCaptures) { controllerCaptures.clear(); }
    controllerEffects.clear(); controllerEffectBytes = 0; controllerEffectsOmitted = 0; lastStreamAck = null;
    rejectControllerReads("Controller frame predates current life or space");
  }

  private void rejectControllerReads(String reason) {
    var pending = pendingControllerReads.keySet().iterator();
    while (pending.hasNext()) {
      long id = pending.next(); pending.remove(); reply(id, null, reason);
      if (!connected) { pendingControllerReads.clear(); break; }
    }
  }

  private boolean residentReadCurrent(ResidentRead read, long now) {
    long evaluated = 1, values = 0;
    boolean current = now < read.deadline();
    if (current) {
      values |= 1; evaluated |= 2; current = read.stream() == streamOwner;
      if (current) {
        values |= 2; evaluated |= 4; current = streamRetirement == null;
        if (current) {
          values |= 4; evaluated |= 8; current = streamInputs != null;
          if (current) {
            values |= 8; evaluated |= 16; current = streamAuthorized();
            if (current) {
              values |= 16; evaluated |= 32; current = !read.stream().queue().expired(now);
              if (current) values |= 32;
            }
          }
        }
      }
    }
    opportunityHook(read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
        current ? NativePreparationTrace.Outcome.PASSED : NativePreparationTrace.Outcome.BLOCKED,
        read.id(), 0, evaluated, values, 21);
    return current;
  }

  private void rejectResidentSample(ResidentRead read, String reason) {
    if (read.stream() == streamOwner && streamRetirement == null) {
      // Receipt may have reserved revoke before publishing its game-thread request.
      if (retirementReserved.get()) return;
      retireController("resident_sample_authority_expired");
    }
    synchronized (controllerSamples) {
      if (!controllerSamples.rejectionReady(read.stream())) return;
      pendingResidentRead = null;
      reply(read.id(), null, reason);
    }
  }

  private void settleResidentSample(boolean rendered) {
    ResidentRead read = pendingResidentRead;
    opportunityHook(read == null ? streamOwner : read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
        NativePreparationTrace.Outcome.OBSERVED, read == null ? 0 : read.id(), 0,
        3, (rendered ? 1 : 0) | (read == null ? 0 : 2), 20);
    if (read == null) return;
    if (!residentReadCurrent(read, System.nanoTime())) {
      rejectResidentSample(read, "Resident sample predates current authority or its deadline");
      return;
    }
    if (!controllerSamples.ready(read.stream(), clientTick, rendered)) return;
    boolean visibleReady = visibleView.ready();
    opportunityHook(read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
        visibleReady ? NativePreparationTrace.Outcome.PASSED : NativePreparationTrace.Outcome.BLOCKED,
        read.id(), 0, 1, visibleReady ? 1 : 0, 22);
    if (!visibleReady) return;
    try {
      incarnationSignals.viewReceived();
      boolean current = residentReadCurrent(read, System.nanoTime());
      opportunityHook(read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
          current ? NativePreparationTrace.Outcome.PASSED : NativePreparationTrace.Outcome.BLOCKED,
          read.id(), 0, 1, current ? 1 : 0, 23);
      if (!current) throw new IllegalStateException("Resident sample scope changed");
      JsonObject frame = controllerFrame(read.cursor());
      long capturedFrame = controllerFrameSequence;
      opportunityHook(read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
          NativePreparationTrace.Outcome.PASSED, read.id(), capturedFrame, 1, 1, 24);
      current = residentReadCurrent(read, System.nanoTime());
      long evaluated = 1, values = current ? 1 : 0;
      boolean sampled = false;
      if (current) {
        evaluated |= 2;
        sampled = controllerSamples.sampled(read.stream(), clientTick, rendered);
        if (sampled) values |= 2;
      }
      opportunityHook(read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
          sampled ? NativePreparationTrace.Outcome.PASSED : NativePreparationTrace.Outcome.BLOCKED,
          read.id(), capturedFrame, evaluated, values, 25);
      if (!current || !sampled)
        throw new IllegalStateException("Resident sample authority changed during capture");
      pendingResidentRead = null;
      reply(read.id(), frame, null);
    } catch (RuntimeException error) {
      opportunityHook(read.stream(), NativePreparationTrace.Kind.SAMPLE_RENDER,
          NativePreparationTrace.Outcome.BLOCKED, read.id(), 0, 1, 1, 26);
      String reason = "Controller frame rejected: " + error.getMessage();
      if (!residentReadCurrent(read, System.nanoTime())) rejectResidentSample(read, reason);
      else { pendingResidentRead = null; reply(read.id(), null, reason); }
    }
  }

  private void settleControllerReads() {
    if (pendingControllerReads.isEmpty()) return;
    var pending = pendingControllerReads.entrySet().iterator();
    while (connected && pending.hasNext()) {
      var entry = pending.next();
      if (System.nanoTime() >= entry.getValue().deadline()) {
        long id = entry.getKey(); pending.remove(); reply(id, null, "Controller frame rendered-source timeout");
      } else if (visibleView.ready()) {
        long id = entry.getKey(); SoundProjection.Cursor cursor = entry.getValue().cursor(); pending.remove();
        try { incarnationSignals.viewReceived(); reply(id, controllerFrame(cursor), null); }
        catch (RuntimeException error) { reply(id, null, "Controller frame rejected: " + error.getMessage()); }
      }
    }
  }

  private JsonElement controllerBlockReference(BlockPos position) {
    if (!reachable(position)) return JsonNull.INSTANCE;
    var reference = blockIncarnations.observe(position, incarnationSignals.space(), lifecycle.lifeId());
    retainControllerTarget(blocks, reference.targetId(), position.toImmutable());
    return NativeEffectContract.target(reference);
  }

  private JsonElement controllerEntityReference(Entity entity) {
    if (!authorizedEntity(entity)) return JsonNull.INSTANCE;
    var reference = entityIncarnations.observe(entity.getUuid(), incarnationSignals.space(), lifecycle.lifeId());
    retainControllerTarget(entities, reference.targetId(), entity);
    return NativeEffectContract.target(reference);
  }

  private static <T> void retainControllerTarget(Map<String, T> targets, String id, T value) {
    if (!targets.containsKey(id) && targets.size() >= 256) targets.remove(targets.keySet().iterator().next());
    targets.put(id, value);
  }

  private static JsonObject audibleCursor(SoundProjection.Cursor cursor) {
    JsonObject value = new JsonObject();
    value.addProperty("stream_id", cursor.streamId()); value.addProperty("sequence", cursor.sequence());
    return value;
  }

  private JsonObject controllerSounds(SoundProjection.Page page) {
    JsonObject value = new JsonObject(); JsonArray events = new JsonArray();
    value.addProperty("stream_id", page.streamId()); value.addProperty("after_sequence", page.afterSequence());
    value.add("next_cursor", audibleCursor(page.nextCursor())); value.addProperty("gap", page.gap());
    value.addProperty("omitted_before", page.omittedBefore()); value.addProperty("has_more", page.hasMore());
    for (var event : page.events()) {
      JsonObject row = new JsonObject();
      row.addProperty("sequence", event.sequence()); row.addProperty("category", SOUND_CATEGORIES[event.category()]);
      row.addProperty("cue", event.cue()); row.addProperty("direction", SOUND_DIRECTIONS[event.direction()]);
      row.addProperty("distance", SOUND_BANDS[event.distance()]);
      row.addProperty("heard_at", Instant.ofEpochMilli(event.wallMillis()).toString());
      row.addProperty("heard_native_ns", Long.toString(event.nativeNanos())); events.add(row);
    }
    value.add("events", events); return value;
  }

  private JsonObject controllerFrame(SoundProjection.Cursor cursor) {
    EffectAuthority.Space space = incarnationSignals.space();
    if (client.player == null || client.world == null || space == null
        || lifecycle.status() == PlayerLifecycle.Status.LOADING || lifecycle.status() == PlayerLifecycle.Status.RESPAWNING)
      throw new IllegalStateException("Authoritative current player space is unavailable");
    long acquisitionStarted = System.nanoTime();
    // No assisted-owner target-store eviction as a side effect of ordinary controller sensing.
    if (motor == null)
      controllerWorld.sample(acquisitionStarted, lifecycle.lifeId(), space, incarnationSignals.screen());
    long now = System.nanoTime();
    JsonObject body = controllerBody.capture(clientTick, now, controllerBlockReference, controllerEntityReference);
    JsonObject value = new JsonObject(), profile = descriptor.getAsJsonObject("observation").getAsJsonObject("profile");
    controllerFrameSequence = ContractIdentity.next(controllerFrameSequence);
    synchronized (controllerCaptures) {
      if (controllerCaptures.size() == 32) controllerCaptures.remove(controllerCaptures.keySet().iterator().next());
      controllerCaptures.put(controllerFrameSequence, new CapturedControllerFrame(clientTick, now, lifecycle.lifeId(), space));
    }
    value.addProperty("schema_version", 2); value.addProperty("frame_seq", controllerFrameSequence);
    value.addProperty("native_tick", clientTick); value.addProperty("captured_native_ns", Long.toString(now));
    value.addProperty("captured_at", Instant.now().toString());
    value.add("profile_id", profile.get("id")); value.add("profile_version", profile.get("version"));
    value.addProperty("life_id", lifecycle.lifeId()); value.add("space", NativeEffectContract.space(space));
    value.add("player", body.get("player")); value.add("inventory", body.get("inventory")); value.add("view", body.get("view"));
    value.add("screen", visibleView.snapshot());
    value.add("last_input", lastStreamAck == null ? JsonNull.INSTANCE : lastStreamAck);
    JsonArray effects = new JsonArray();
    for (ControllerEffect effect : controllerEffects) effects.add(effect.value());
    value.add("effect_updates", effects); value.addProperty("effect_updates_omitted", controllerEffectsOmitted);
    // Scan time belongs to the acquisition's age, not a new freshness timestamp.
    JsonObject world = controllerWorld.retained(now, lifecycle.lifeId(), space, incarnationSignals.screen());
    value.add("visible_world", world == null ? JsonNull.INSTANCE : world);
    value.add("audible", controllerSounds(sounds.page(cursor, System.nanoTime())));
    return value;
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
    final NativeInputTiming inputTiming = new NativeInputTiming();
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
    JsonObject craftStageBefore;
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
      applicationRejection.add("expected_screen", NativeEffectContract.precondition(received.expectedScreen()));
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
      if (kind.equals("interact") && targetEntityBinding instanceof ItemEntity) {
        finish("failed",
            "Dropped items are proximity pickups, not right-click interactions. "
                + "Approach with ordinary movement or navigation, then confirm collection from a fresh inventory receipt",
            false);
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
        craftStageBefore = inventoryBefore;
        duration = VisibleInventory.craftMillis(Recipes.totalExecutions(action));
        if (tableReference != null) {
          target = tableBinding;
          String tableRefusal = null;
          if (target == null)
            tableRefusal = "Supplied crafting table has no current target binding";
          else if (!(client.player.getEyePos().squaredDistanceTo(target.toCenterPos()) <= 25))
            tableRefusal = "Supplied crafting table is beyond interaction reach";
          else if (!clearLine(target.toCenterPos(), target)
              || !client.world.raycast(
                  new RaycastContext(
                      client.player.getEyePos(),
                      target.toCenterPos(),
                      RaycastContext.ShapeType.OUTLINE,
                      RaycastContext.FluidHandling.NONE,
                      client.player))
                  .getBlockPos().equals(target))
            tableRefusal = "Line of sight to supplied crafting table is blocked or unavailable";
          if (tableRefusal != null) {
            finish("failed", tableRefusal, false);
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
      client.player.changeLookDirection(MathHelper.wrapDegrees(camera.yaw - beforeYaw) / .15,
          (camera.pitch - beforePitch) / .15);
      if (Math.abs(MathHelper.wrapDegrees(client.player.getYaw() - beforeYaw)) > .0001
          || Math.abs(client.player.getPitch() - beforePitch) > .0001) {
        emissions |= EffectOutcome.CAMERA;
      }
      if (client.player.getYaw() != beforeYaw || client.player.getPitch() != beforePitch)
        inputTiming.cameraApply.record(System.nanoTime(), clientTick);
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
              finish("failed", Recipes.beginRefusalReason(), false);
              return;
            }
            if (tableReference != null) emissions |= EffectOutcome.WORLD_EFFECT;
          }
          Recipes.tick(client);
          inventoryEmissions();
          if (Recipes.invalidated()) {
            // Revoke pending gestures before server custody inspection; cleanup
            // closes only the exact old handler and never releases a held drag.
            if (Recipes.session() != null) Recipes.session().cancel(true);
            if (Recipes.needsReceipt()) {
              requestInventory();
              if (serverInventoryAfter == null) return;
              Recipes.receipt(client, craftStageBefore, serverInventoryAfter,
                  received.owner().operationId() + ":craft:" + receiptNonce);
            }
            finish(EffectOutcome.deadline(emissions), "Visible crafting interrupted: " + Recipes.session().reason(), false);
            return;
          }
          if (Recipes.awaitingReceipt()) {
            requestInventory();
            if (serverInventoryAfter == null) return;
            Recipes.receipt(client, craftStageBefore, serverInventoryAfter,
                received.owner().operationId() + ":craft:" + receiptNonce);
            craftStageBefore = serverInventoryAfter.getAsJsonObject("counts");
            receiptNonce = 0;
            serverInventoryAfter = null;
            return;
          }
          if (Recipes.complete()) {
            requestInventory();
            if (serverInventoryAfter == null) return;
            boolean gained = serverInventoryClean();
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
      JsonArray craftStages = kind.equals("craft") ? Recipes.stageEvidence() : null;
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
      applyInput(this);
      if (client.interactionManager != null) client.interactionManager.cancelBlockBreaking();
      if (client.player != null) client.player.stopUsingItem();
      JsonObject outcome = result(status, summary, effect);
      JsonObject evidence = outcome.getAsJsonObject("evidence");
      samplePose();
      evidence.addProperty("life_id", lifeId);
      evidence.addProperty("native_generation", generation);
      evidence.add("native_input_timing", inputTiming.evidence(
          effectAuthority.nativeBootId(), id, received.owner().operationId(), generation));
      evidence.addProperty("world_effect_emitted", (emissions & EffectOutcome.WORLD_EFFECT) != 0);
      evidence.addProperty("camera_changed", (emissions & EffectOutcome.CAMERA) != 0);
      if (inventoryUi != null) evidence.add("native_inventory_ui", inventoryUi);
      if (craftStages != null) evidence.add("craft_stages", craftStages);
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
