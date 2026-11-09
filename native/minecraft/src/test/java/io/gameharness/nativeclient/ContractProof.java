package io.gameharness.nativeclient;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/** Production contract/queue/target behavior proof. Live Minecraft hook conformance is a separate smoke. */
public final class ContractProof {
  private static final String HASH = "a".repeat(64);
  private static void require(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }
  private static EffectAuthority.Scope scope(EffectAuthority authority, long life, long space, String execution, String hash) {
    return new EffectAuthority.Scope("session", "world", 2147483665L, authority.nativeBootId(), "run", 2147483699L,
        life, space, execution, hash);
  }
  private static EffectAuthority.Owner owner(EffectAuthority authority, long life, long space, String operation) {
    return new EffectAuthority.Owner(operation, scope(authority, life, space, "invocation", HASH), authority.cancellationGeneration());
  }

  public static void main(String[] ignored) throws Exception {
    NativeTimingProof.main(ignored);
    WorldInputProof.main(ignored);
    VisibleScreenProof.main(ignored);
    GuiProductionProof.main(ignored);
    ControllerRenderProof.main(ignored);
    ControllerStreamProof.main(ignored);
    InputConsumptionProof.main(ignored);
    producerSupervision();
    NativeControlWriterProof.main(ignored);
    NativeEvaluationProof.main(ignored);
    visibleInventoryCustody();
    InventoryMotionProof.main(ignored);
    require(ContractIdentity.counter("2147483665") == 2147483665L, "epoch narrowed through signed int");
    require(ContractIdentity.counter("9007199254740991") == ContractIdentity.MAX_SAFE, "safe endpoint narrowed");
    require(ContractIdentity.counter("2.147483665e9") == 2147483665L, "exact JSON exponent lost identity");
    for (String bad : new String[] {"-1", "0.5", "9007199254740992", "9223372036854775808", "1e100", "\"7\"", "null", "NaN", "01", "+1"}) {
      boolean rejected = false;
      try { ContractIdentity.counter(bad); } catch (IllegalArgumentException expected) { rejected = true; }
      require(rejected, "malformed/unsafe identity admitted: " + bad);
    }
    boolean exhausted = false;
    try { ContractIdentity.next(ContractIdentity.MAX_SAFE); } catch (IllegalStateException expected) { exhausted = true; }
    require(exhausted, "identity counter wrapped");
    var maximalScope = new EffectAuthority.Scope("session", "world", ContractIdentity.MAX_SAFE, "native-boot", "run",
        2147483665L, 3, 4, "invocation", HASH);
    var decodedScope = NativeEffectContract.scope(NativeEffectContract.scope(maximalScope));
    require(decodedScope.epoch() == ContractIdentity.MAX_SAFE && decodedScope.runGeneration() == 2147483665L,
        "actual Gson scope codec narrowed a JavaScript-safe counter");
    var quotedEpoch = NativeEffectContract.scope(maximalScope);
    quotedEpoch.addProperty("epoch", "2147483665");
    boolean quotedRejected = false;
    try { NativeEffectContract.scope(quotedEpoch); } catch (IllegalArgumentException expected) { quotedRejected = true; }
    require(quotedRejected, "actual Gson scope codec accepted a string counter");

    // Explicit absence is a mandatory apply-time precondition, not permission
    // for a newly opened handler to be closed by already-dispatched work.
    EffectAuthority noScreenAuthority = new EffectAuthority("session", "world", 2147483665L);
    noScreenAuthority.bind(HASH, 3, new EffectAuthority.Space("minecraft:overworld", 4), null);
    EffectAuthority.Owner noScreenOwner = owner(noScreenAuthority, 3, 4, "no-screen-operation");
    require(noScreenAuthority.grant(noScreenOwner, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE,
        "closed-view positive control failed before screen transition");
    require(noScreenAuthority.validateApplication(noScreenOwner, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE,
        "explicit no-screen positive control was rejected");
    noScreenAuthority.screenChanged(new EffectAuthority.Screen("new-handler", 1, 0));
    require(noScreenAuthority.validateApplication(noScreenOwner, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.STALE_SCREEN,
        "explicit no-screen precondition became unrestricted after native receive");
    require(noScreenAuthority.complete(noScreenOwner), "original no-screen owner did not retire");
    EffectAuthority.Owner staleNoScreenReceive = owner(noScreenAuthority, 3, 4, "stale-no-screen-receive");
    require(noScreenAuthority.grant(staleNoScreenReceive, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.STALE_SCREEN
        && noScreenAuthority.owner() == null, "receive granted an owner against explicit absence after a screen opened");

    var noScreenWire = new com.google.gson.JsonObject();
    noScreenWire.addProperty("operation_id", noScreenOwner.operationId());
    noScreenWire.addProperty("compatibility_hash", HASH);
    noScreenWire.add("scope", NativeEffectContract.scope(noScreenOwner.scope()));
    var noScreenInvocation = new com.google.gson.JsonObject();
    noScreenInvocation.addProperty("kind", "diagnostic");
    noScreenInvocation.addProperty("execution_id", noScreenOwner.scope().executionId());
    noScreenInvocation.addProperty("source_hash", HASH);
    noScreenWire.add("invocation", noScreenInvocation);
    var noScreenAction = new com.google.gson.JsonObject(); noScreenAction.addProperty("kind", "look");
    noScreenAction.addProperty("yaw", 0); noScreenAction.addProperty("pitch", 0);
    noScreenWire.add("action", noScreenAction);
    noScreenWire.add("expected_screen", NativeEffectContract.precondition(EffectAuthority.ScreenPrecondition.absent()));
    require(NativeEffectContract.effect(noScreenWire, noScreenOwner.cancellationGeneration()).expectedScreen().kind().equals("absent"),
        "actual native JSON codec lost explicit screen absence");
    noScreenWire.add("expected_screen", com.google.gson.JsonNull.INSTANCE);
    boolean legacyScreenRejected = false;
    try { NativeEffectContract.effect(noScreenWire, noScreenOwner.cancellationGeneration()); }
    catch (RuntimeException expected) { legacyScreenRejected = true; }
    require(legacyScreenRejected, "legacy null screen wire granted authority");
    noScreenWire.remove("expected_screen");
    boolean missingScreenRejected = false;
    try { NativeEffectContract.effect(noScreenWire, noScreenOwner.cancellationGeneration()); }
    catch (IllegalArgumentException expected) { missingScreenRejected = true; }
    require(missingScreenRejected, "active native effect accepted an omitted screen precondition");

    EffectAuthority authority = new EffectAuthority("session", "world", 2147483665L);
    require(authority.nativeBootId().equals(new EffectAuthority("another-session", "world", 2).nativeBootId()),
        "native boot identity changed inside one JVM process");
    EffectAuthority.Space overworld = new EffectAuthority.Space("minecraft:overworld", 4);
    EffectAuthority.Owner first = owner(authority, 3, 4, "operation-A");
    require(authority.grant(first, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NOT_READY, "loading fabricated an initial space/readiness");
    authority.bind(HASH, 3, overworld, null);
    first = owner(authority, 3, 4, "operation-A");
    require(authority.grant(first, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE, "matching owner not admitted");
    require(first.scope().runGeneration() != first.cancellationGeneration(), "host/native generations accidentally conflated");
    require(authority.validateApplication(first, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE, "matching apply was rejected");
    require(authority.validateApplication(first, "b".repeat(64), EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.STALE_BINDING,
        "mismatched descriptor acquired native authority");
    EffectAuthority.Scope sourceChanged = scope(authority, 3, 4, "replacement-invocation", "b".repeat(64));
    require(authority.validateApplication(new EffectAuthority.Owner("operation-A", sourceChanged, authority.cancellationGeneration()), HASH, EffectAuthority.ScreenPrecondition.absent())
        == EffectAuthority.Rejection.INACTIVE_OWNER, "old source/invocation bypassed owner fence");
    EffectAuthority.Scope bootChanged = new EffectAuthority.Scope("session", "world", 2147483665L, "other-boot", "run", 2147483699L,
        3, 4, "invocation", HASH);
    require(authority.grant(new EffectAuthority.Owner("other-boot", bootChanged, authority.cancellationGeneration()), HASH, EffectAuthority.ScreenPrecondition.absent())
        == EffectAuthority.Rejection.STALE_SCOPE, "stale native boot admitted");

    // Queue a production application check behind a stalled executor. An actual
    // authority transition between receive and application must leave zero effects.
    AtomicInteger effects = new AtomicInteger();
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    final EffectAuthority.Owner queuedOwner = first;
    try (var gameThread = Executors.newSingleThreadExecutor()) {
      gameThread.submit(() -> {
        entered.countDown();
        try { release.await(); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
      });
      entered.await();
      var application = gameThread.submit(() -> {
        if (authority.validateApplication(queuedOwner, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE) effects.incrementAndGet();
      });
      authority.spaceChanged(new EffectAuthority.Space("minecraft:overworld", 5));
      release.countDown(); application.get();
    }
    require(effects.get() == 0, "queued old-space work acted after same-dimension relocation");
    require(authority.close(first) == false, "stale cleanup revoked replacement authority");
    EffectAuthority.Owner replacement = owner(authority, 3, 5, "operation-B");
    require(authority.grant(replacement, HASH, EffectAuthority.ScreenPrecondition.absent()) == EffectAuthority.Rejection.NONE, "replacement owner not admitted");
    require(!authority.close(first) && authority.owner().equals(replacement), "late A cleanup revoked B");
    authority.lifeChanged(4);
    require(authority.validateApplication(replacement, HASH, EffectAuthority.ScreenPrecondition.absent()) != EffectAuthority.Rejection.NONE, "old-life work applied after respawn");
    require(authority.space().epoch() == 5, "life and space were collapsed into one counter");
    EffectAuthority.Screen beforeScreen = new EffectAuthority.Screen("screen-A", 1, 0);
    authority.bind(HASH, 4, authority.space(), beforeScreen);
    EffectAuthority.Owner screenOwner = owner(authority, 4, 5, "screen-operation");
    require(authority.grant(screenOwner, HASH, EffectAuthority.ScreenPrecondition.transaction(beforeScreen)) == EffectAuthority.Rejection.NONE, "screen owner not admitted");
    authority.screenChanged(new EffectAuthority.Screen("screen-B", 2, 0));
    require(authority.validateApplication(screenOwner, HASH, EffectAuthority.ScreenPrecondition.transaction(beforeScreen)) == EffectAuthority.Rejection.STALE_SCREEN,
        "queued expected screen instance was silently retargeted");
    require(authority.validateApplication(screenOwner, HASH) == EffectAuthority.Rejection.NONE,
        "native helper's internal view transition invented a new UI capability precondition");
    require(authority.complete(screenOwner), "normal operation did not retire its owner");
    EffectAuthority.Owner nextOperation = owner(authority, 4, 5, "following-operation");
    require(authority.grant(nextOperation, HASH, EffectAuthority.ScreenPrecondition.transaction(authority.screen())) == EffectAuthority.Rejection.NONE, "following owner was not admitted");
    require(!authority.close(screenOwner) && authority.owner().equals(nextOperation), "late completed-owner cleanup revoked the following operation");

    record Cell(int x, int y, int z) {}
    Cell cell = new Cell(0, 64, 0);
    TargetIncarnations<Cell> targets = new TargetIncarnations<>(2);
    var oldTarget = targets.observe(cell, overworld, 3);
    require(targets.current(cell, oldTarget, overworld, 3), "fresh target missing");
    // In-flight owners retain the admitted cell binding, not a later observation
    // list entry. Observing other cells must not revoke that actual incarnation.
    Cell neighbor = new Cell(1, 64, 0);
    targets.observe(neighbor, overworld, 3);
    require(targets.current(cell, oldTarget, overworld, 3),
        "observation of a different cell revoked an admitted binding");
    require(!targets.current(neighbor, oldTarget, overworld, 3),
        "retained handle silently retargeted to a different cell");
    require(!targets.current(cell, oldTarget, overworld, 4),
        "retained admitted binding crossed a player life");
    require(!targets.current(cell, oldTarget, new EffectAuthority.Space("minecraft:overworld", 5), 3),
        "retained admitted binding crossed same-dimension relocation");
    targets.replaced(cell);
    require(!targets.current(cell, oldTarget, overworld, 3),
        "retained admitted binding survived actual removal before any re-observation");
    var newTarget = targets.observe(cell, overworld, 3);
    require(!oldTarget.equals(newTarget) && !targets.current(cell, oldTarget, overworld, 3),
        "replacement at identical coordinates retained old target incarnation");
    var nether = new EffectAuthority.Space("minecraft:the_nether", 6);
    var dimensionTarget = targets.observe(cell, nether, 3);
    require(!dimensionTarget.equals(newTarget) && !targets.current(cell, newTarget, nether, 3),
        "identical coordinates crossed spaces as the same target");
    targets.invalidate();
    require(!targets.current(cell, dimensionTarget, nether, 3), "uncertainty did not fence handles");
    var boundedTarget = targets.observe(cell, overworld, 3);
    targets.observe(neighbor, overworld, 3);
    targets.pin(cell, boundedTarget);
    targets.observe(new Cell(2, 64, 0), overworld, 3);
    require(targets.current(cell, boundedTarget, overworld, 3),
        "bounded observation churn evicted an active mechanical pin");
    targets.unpin(cell);
    targets.observe(new Cell(3, 64, 0), overworld, 3);
    require(!targets.current(cell, boundedTarget, overworld, 3),
        "owned binding bypassed bounded incarnation-store revocation");

    ScreenIncarnations screens = new ScreenIncarnations();
    Object viewA = new Object(), viewB = new Object();
    require(screens.viewChanged(viewA), "first screen unavailable");
    var screenA = screens.screen();
    require(!screens.viewChanged(viewA) && screens.screen().equals(screenA), "ordinary refresh changed instance");
    require(screens.transactionChanged(viewA) && !screens.screen().equals(screenA), "relevant screen transaction failed to revise");
    require(screens.viewChanged(viewB) && !screens.screen().id().equals(screenA.id()), "same-class replacement screen reused identity");
    require(!screens.transactionChanged(viewA), "late old-view callback revised replacement screen");
    screens.invalidate(); require(screens.screen() == null, "uncertain screen retained authority");

    require(NativeContractResource.RADIUS == 8 && NativeContractResource.MAX_BLOCKS == 144
        && NativeContractResource.MAX_ENTITIES == 32, "compiled effective sampler is not the actual current condition");
    System.out.println("Native contract counter/queue/owner/target/screen/build-resource proof passed");
  }

  private static void visibleInventoryCustody() {
    Object screen = new Object(), handler = new Object();
    InventoryGestureFence fence = new InventoryGestureFence(screen, handler, 7);
    require(fence.allows(screen, handler, 7, true), "owned matching layout/custody refused");
    require(!fence.allows(screen, new Object(), 7, true), "replacement handler inherited gesture");
    require(!fence.allows(new Object(), handler, 7, true), "replacement screen inherited gesture");
    require(!fence.allows(screen, handler, 8, true), "changed sync ID inherited gesture");
    require(!fence.allows(screen, handler, 7, false), "changed cursor/grid/slot custody admitted");
    fence.press();
    require(fence.held(), "press not retained until visible release");
    fence.revoke();
    require(!fence.held() && !fence.allows(screen, handler, 7, true),
        "revocation retained a release capable of committing vanilla drag");
    require(fence.cleanupOwns(screen, handler, 7), "trusted same-handler cleanup lost scope");
    require(!fence.cleanupOwns(screen, new Object(), 7), "cleanup retargeted replacement handler");
    InventoryGestureFence delayed = new InventoryGestureFence(screen, handler, 7);
    delayed.press();
    delayed.release();
    delayed.revoke();
    require(!delayed.allows(screen, handler, 7, true), "delayed correction replayed completed click");
    require(!InventoryGestureFence.cleanCustody(1, 0)
        && !InventoryGestureFence.cleanCustody(0, 1)
        && InventoryGestureFence.cleanCustody(0, 0), "receipt ignored cursor/grid custody");
  }

  private static void producerSupervision() {
    var wire = new com.google.gson.JsonObject();
    wire.addProperty("session_id", "executive"); wire.addProperty("behavior_generation", 1);
    wire.addProperty("frame_seq", 10);
    long now = -9_007_199_254_740_997L;
    var lease = new ProducerSupervision(wire);
    require(!lease.admit(now - 150_000_001L, now), "stale executive admitted a semantic producer");
    require(lease.admit(now, now) && lease.deadline() == now + 250_000_000L,
        "semantic producer lease did not derive from its exact capture time");
    require(!lease.renew("other", 1, 11, now, now), "foreign executive renewed producer");
    require(!lease.renew("executive", 2, 11, now, now), "foreign behavior generation renewed producer");
    require(!lease.renew("executive", 1, 10, now, now), "same stale decision renewed producer");
    require(lease.renew("executive", 1, 11, now + 50_000_000L, now + 50_000_000L),
        "fresh exact continuation failed");
    require(!lease.current(now + 500_000_000L)
        && !lease.renew("executive", 1, 12, now + 500_000_000L, now + 500_000_000L),
        "500ms executive stall retained or resurrected a semantic producer");
    var retired = new ProducerSupervision(wire);
    require(retired.admit(now, now), "retirement positive control failed");
    retired.retire();
    require(!retired.renew("executive", 1, 11, now + 1, now + 1), "retiring child renewed supervision");
  }
}
