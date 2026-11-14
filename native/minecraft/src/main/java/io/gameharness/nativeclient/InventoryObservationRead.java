package io.gameharness.nativeclient;

import java.util.Objects;

/** A read's server receipt belongs to its request and player scope, not an effect lease. */
public final class InventoryObservationRead {
  private final long requestId, generation, lifeId;
  private final Object connection, player, world;
  private final EffectAuthority.Space space;
  private final String compatibilityHash;

  public InventoryObservationRead(long requestId, long generation, Object connection,
      Object player, Object world, long lifeId, EffectAuthority.Space space,
      String compatibilityHash) {
    this.requestId = ContractIdentity.checked(requestId);
    this.generation = ContractIdentity.checked(generation);
    this.connection = Objects.requireNonNull(connection);
    this.player = Objects.requireNonNull(player);
    this.world = Objects.requireNonNull(world);
    this.lifeId = ContractIdentity.checked(lifeId);
    this.space = Objects.requireNonNull(space);
    this.compatibilityHash = ContractIdentity.hash(compatibilityHash);
  }

  public long requestId() { return requestId; }

  public boolean accepts(long receiptGeneration, Object connection, Object player,
      Object world, long lifeId, EffectAuthority.Space space, String compatibilityHash) {
    return generation == receiptGeneration && this.connection == connection
        && this.player == player && this.world == world && this.lifeId == lifeId
        && this.space.equals(space) && this.compatibilityHash.equals(compatibilityHash);
  }
}
