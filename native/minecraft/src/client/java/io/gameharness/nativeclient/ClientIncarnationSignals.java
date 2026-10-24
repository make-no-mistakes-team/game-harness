package io.gameharness.nativeclient;

import java.util.Objects;
import java.util.UUID;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.util.math.BlockPos;

/** Actual pinned client state signals; connected to packet/view hooks at the atomic API4 cutover. */
public final class ClientIncarnationSignals {
  public interface Listener {
    /** The authority fence has already closed old work; release inputs before publishing. */
    void scopeFenced();
    void screenChanged();
  }
  private final MinecraftClient client;
  private final EffectAuthority authority;
  private final TargetIncarnations<BlockPos> blocks;
  private final TargetIncarnations<UUID> entities;
  private final ScreenIncarnations screens;
  private final Listener listener;
  private EffectAuthority.Space space;
  private long spaceEpoch;
  private Object handler;

  public ClientIncarnationSignals(MinecraftClient client, EffectAuthority authority,
      TargetIncarnations<BlockPos> blocks, TargetIncarnations<UUID> entities,
      ScreenIncarnations screens, Listener listener) {
    this.client = Objects.requireNonNull(client); this.authority = Objects.requireNonNull(authority);
    this.blocks = Objects.requireNonNull(blocks); this.entities = Objects.requireNonNull(entities);
    this.screens = Objects.requireNonNull(screens); this.listener = Objects.requireNonNull(listener);
  }

  public EffectAuthority.Space space() { return space; }
  public EffectAuthority.Screen screen() { return screens.screen(); }

  /** onGameJoin / onPlayerRespawn / onPlayerPositionLook TAIL, never a coordinate-distance heuristic. */
  public void authoritativeSpaceReceived() {
    if (client.world == null) {
      loading();
      return;
    }
    try {
      spaceEpoch = ContractIdentity.next(spaceEpoch);
      space = new EffectAuthority.Space(client.world.getRegistryKey().getValue().toString(), spaceEpoch);
      authority.spaceChanged(space);
    } catch (IllegalStateException error) {
      loading();
      throw error;
    }
    blocks.invalidate(); entities.invalidate();
    listener.scopeFenced();
  }

  /** Ordinary dimension travel invokes only the space path; actual respawn readiness supplies this life. */
  public void authoritativeLifeChanged(long lifeId) {
    authority.lifeChanged(lifeId);
    blocks.invalidate(); entities.invalidate();
    listener.scopeFenced();
  }

  public void loading() {
    space = null;
    blocks.invalidate(); entities.invalidate(); screens.invalidate(); handler = null;
    authority.loading();
    listener.scopeFenced();
  }

  /** MinecraftClient.setScreen TAIL; handler replacement also changes identity, even for the same view object. */
  public void viewReceived() {
    Object currentHandler = client.player == null ? null : client.player.currentScreenHandler;
    boolean handlerChanged = currentHandler != handler;
    if (handlerChanged) { handler = currentHandler; screens.invalidate(); }
    boolean viewChanged = screens.viewChanged(client.currentScreen);
    if (handlerChanged || viewChanged) {
      authority.screenChanged(screens.screen());
      listener.screenChanged();
    }
  }

  /** Slot/cursor/selected-inventory packets, NOT ScreenHandlerPropertyUpdate progress animation. */
  public void relevantTransactionReceived() {
    viewReceived();
    if (screens.transactionChanged(client.currentScreen)) {
      authority.screenChanged(screens.screen());
      listener.screenChanged();
    }
  }

  public void blockReplaced(BlockPos position) { blocks.replaced(position); }
  public void entityReplaced(Entity entity) { entities.replaced(entity.getUuid()); }
}
