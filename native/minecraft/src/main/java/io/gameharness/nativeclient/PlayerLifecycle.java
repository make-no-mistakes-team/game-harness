package io.gameharness.nativeclient;

/** Authoritative player incarnations, independent of the owned client connection. */
public final class PlayerLifecycle {
  public enum Decision { WAIT, READY, DIED, RESPAWN_FAILED }
  public enum Status { LOADING, ALIVE, DEAD, RESPAWNING }

  private Status status = Status.LOADING;
  private long lifeId;
  private long respawnDeadline;
  private boolean replacementSeen;
  private boolean replacementHealth;
  private boolean replacementPosition;
  private boolean replacementDead;
  private boolean timeoutReported;

  public Decision update(boolean alive, boolean authoritative, long now) {
    if (status == Status.RESPAWNING) {
      // A delayed old-player health packet must never establish a new incarnation.
      if (authoritative && replacementSeen && alive) replacementHealth = true;
      if (authoritative && replacementSeen && replacementHealth && !alive) replacementDead = true;
      // The replacement really lived and died, even if its custom readiness receipt lost the race.
      // It is a distinct dead incarnation, never resurrection or a replay of the prior request.
      if (replacementSeen && replacementHealth && replacementPosition && replacementDead) {
        lifeId++;
        status = Status.DEAD;
        return Decision.DIED;
      }
      if (now >= respawnDeadline && !timeoutReported) {
        timeoutReported = true;
        return Decision.RESPAWN_FAILED;
      }
      return Decision.WAIT;
    }
    if (status == Status.DEAD) return Decision.DIED;
    if (!alive && (authoritative || status == Status.ALIVE)) {
      if (lifeId == 0) lifeId = 1;
      status = Status.DEAD;
      return Decision.DIED;
    }
    if (alive && authoritative && status == Status.LOADING) {
      lifeId = 1;
      status = Status.ALIVE;
    }
    return ready() ? Decision.READY : Decision.WAIT;
  }

  public boolean beginRespawn(long expectedLife, boolean vanillaReady, long now) {
    if (status != Status.DEAD || lifeId != expectedLife || !vanillaReady) return false;
    status = Status.RESPAWNING;
    replacementSeen = false;
    replacementHealth = false;
    replacementPosition = false;
    replacementDead = false;
    timeoutReported = false;
    respawnDeadline = now + 10000;
    return true;
  }

  public void playerReplaced() {
    if (status == Status.RESPAWNING) replacementSeen = true;
  }

  public void positionReceived() {
    if (status == Status.RESPAWNING && replacementSeen) replacementPosition = true;
  }

  /** A fresh server inventory/health receipt after player replacement closes recovery. */
  public boolean confirmRespawn(boolean alive) {
    if (status != Status.RESPAWNING
        || !replacementSeen || !replacementHealth || !replacementPosition || replacementDead || !alive) return false;
    lifeId++;
    status = Status.ALIVE;
    return true;
  }

  public boolean ready() { return status == Status.ALIVE; }
  public long lifeId() { return lifeId; }
  public Status status() { return status; }
}
