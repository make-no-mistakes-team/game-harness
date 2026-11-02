package io.gameharness.nativeclient;

import java.util.Objects;
import java.util.UUID;

/** Native half of the existing host arbiter. Grants arrive only on its authenticated control channel. */
public final class EffectAuthority {
  public record Space(String dimensionId, long epoch) {
    public Space { ContractIdentity.id(dimensionId); ContractIdentity.checked(epoch); }
  }
  public record Screen(String id, long incarnation, long revision) {
    public Screen { ContractIdentity.id(id); ContractIdentity.checked(incarnation); ContractIdentity.checked(revision); }
  }
  public record VisibleScreenRef(String id, long incarnation, long layoutRevision) {
    public VisibleScreenRef { ContractIdentity.id(id); ContractIdentity.checked(incarnation); ContractIdentity.checked(layoutRevision); }
  }
  public record ScreenPrecondition(String kind, Screen transaction, VisibleScreenRef layout) {
    public ScreenPrecondition {
      if (!(kind.equals("absent") && transaction == null && layout == null
          || kind.equals("transaction") && transaction != null && layout == null
          || kind.equals("layout") && transaction == null && layout != null))
        throw new IllegalArgumentException("Invalid screen precondition");
    }
    public static ScreenPrecondition absent() { return new ScreenPrecondition("absent", null, null); }
    public static ScreenPrecondition transaction(Screen screen) { return new ScreenPrecondition("transaction", screen, null); }
    public static ScreenPrecondition layout(VisibleScreenRef screen) { return new ScreenPrecondition("layout", null, screen); }
  }
  public record Scope(String sessionId, String worldId, long epoch, String nativeBootId,
      String runId, long runGeneration, long lifeId, long spaceEpoch, String executionId, String sourceHash) {
    public Scope {
      ContractIdentity.id(sessionId); ContractIdentity.id(worldId); ContractIdentity.checked(epoch);
      ContractIdentity.id(nativeBootId); ContractIdentity.id(runId); ContractIdentity.checked(runGeneration);
      ContractIdentity.checked(lifeId); ContractIdentity.checked(spaceEpoch); ContractIdentity.id(executionId);
      ContractIdentity.hash(sourceHash);
    }
  }
  public record Owner(String operationId, Scope scope, long cancellationGeneration) {
    public Owner {
      ContractIdentity.id(operationId); Objects.requireNonNull(scope); ContractIdentity.checked(cancellationGeneration);
    }
  }
  public enum Rejection { NONE, NOT_READY, STALE_BINDING, STALE_SCOPE, INACTIVE_OWNER, STALE_SCREEN }

  private static final String NATIVE_BOOT_ID = UUID.randomUUID().toString();
  private final String sessionId;
  private final String worldId;
  private final long epoch;
  private String compatibilityHash;
  private long lifeId;
  private Space space;
  private Screen screen;
  private Owner owner;
  private long cancellationGeneration = 1;
  private boolean ready;

  public EffectAuthority(String sessionId, String worldId, long epoch) {
    this.sessionId = ContractIdentity.id(sessionId);
    this.worldId = ContractIdentity.id(worldId);
    this.epoch = ContractIdentity.checked(epoch);
  }
  public String nativeBootId() { return NATIVE_BOOT_ID; }
  public synchronized long cancellationGeneration() { return cancellationGeneration; }
  public synchronized Owner owner() { return owner; }
  public synchronized Space space() { return space; }
  public synchronized Screen screen() { return screen; }
  public synchronized boolean ready() { return ready; }

  /** A real handshake and authoritative loading facts precede readiness; no invented initial dimension. */
  public synchronized void bind(String compatibilityHash, long lifeId, Space space, Screen screen) {
    this.compatibilityHash = ContractIdentity.hash(compatibilityHash);
    this.lifeId = ContractIdentity.checked(lifeId);
    this.space = Objects.requireNonNull(space);
    this.screen = screen;
    this.owner = null;
    this.ready = true;
  }

  public synchronized void loading() {
    ready = false;
    owner = null;
    space = null;
    screen = null;
    cancellationGeneration = ContractIdentity.next(cancellationGeneration);
  }

  public synchronized void lifeChanged(long lifeId) {
    this.lifeId = ContractIdentity.checked(lifeId);
    revoke();
  }

  /** Dimension travel or a pinned discontinuous-relocation signal; never a position-distance heuristic. */
  public synchronized void spaceChanged(Space space) {
    this.space = Objects.requireNonNull(space);
    revoke();
  }

  public synchronized void screenChanged(Screen screen) {
    this.screen = screen;
  }

  private void revoke() {
    owner = null;
    cancellationGeneration = ContractIdentity.next(cancellationGeneration);
  }

  public synchronized Rejection grant(Owner next, String compatibilityHash, ScreenPrecondition expectedScreen) {
    Rejection scope = validateScope(next.scope(), compatibilityHash);
    if (scope != Rejection.NONE) return scope;
    if (next.cancellationGeneration() != cancellationGeneration) return Rejection.INACTIVE_OWNER;
    if (owner != null) return Rejection.INACTIVE_OWNER;
    if (!matchesScreen(expectedScreen)) return Rejection.STALE_SCREEN;
    owner = next;
    return Rejection.NONE;
  }

  private Rejection validateScope(Scope scope, String compatibilityHash) {
    if (!ready || space == null) return Rejection.NOT_READY;
    if (!Objects.equals(this.compatibilityHash, compatibilityHash)) return Rejection.STALE_BINDING;
    if (!sessionId.equals(scope.sessionId()) || !worldId.equals(scope.worldId()) || epoch != scope.epoch()
        || !NATIVE_BOOT_ID.equals(scope.nativeBootId()) || lifeId != scope.lifeId() || space.epoch() != scope.spaceEpoch())
      return Rejection.STALE_SCOPE;
    return Rejection.NONE;
  }

  /** Called on receive AND again on the game thread immediately before effects, after queueing. */
  public synchronized Rejection validateApplication(Owner expected, String compatibilityHash, ScreenPrecondition expectedScreen) {
    Rejection continuity = validateApplication(expected, compatibilityHash);
    if (continuity != Rejection.NONE) return continuity;
    return matchesScreen(expectedScreen) ? Rejection.NONE : Rejection.STALE_SCREEN;
  }

  /** Layout admission is identity only. The GUI writer rechecks actual layout/local values per effect. */
  private boolean matchesScreen(ScreenPrecondition expected) {
    Objects.requireNonNull(expected);
    return switch (expected.kind()) {
      case "absent" -> screen == null;
      case "transaction" -> Objects.equals(expected.transaction(), screen);
      case "layout" -> screen != null && screen.id().equals(expected.layout().id())
          && screen.incarnation() == expected.layout().incarnation();
      default -> false;
    };
  }

  /** Continuing an already-applied helper may follow its own UI transitions. */
  public synchronized Rejection validateApplication(Owner expected, String compatibilityHash) {
    Rejection scope = validateScope(expected.scope(), compatibilityHash);
    if (scope != Rejection.NONE) return scope;
    if (owner == null || !owner.equals(expected) || expected.cancellationGeneration() != cancellationGeneration)
      return Rejection.INACTIVE_OWNER;
    return Rejection.NONE;
  }

  /** Ordinary cleanup is compare-and-revoke; it cannot neutralize a replacement owner. */
  public synchronized boolean close(Owner expected) {
    if (owner == null || !owner.equals(expected)) return false;
    revoke();
    return true;
  }

  /** Normal completion retires this operation without changing the native cancellation clock. */
  public synchronized boolean complete(Owner expected) {
    if (owner == null || !owner.equals(expected)) return false;
    owner = null;
    return true;
  }

  /** Only trusted Pause/Stop/session lifecycle calls this global operation. */
  public synchronized void emergencyStop() { revoke(); }
}
