package io.gameharness.nativeclient;

/**
 * Pure behavior regressions; no credentials, fixture world, native game or privileged game
 * mutation.
 */
public final class BoundaryProof {
  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  public static void main(String[] ignored) {
    VideoFrameQueueProof.main(ignored);
    SoundProjectionProof.main(ignored);
    Object connection = new Object(), player = new Object(), world = new Object();
    String profile = "a".repeat(64);
    EffectAuthority.Space space = new EffectAuthority.Space("minecraft:overworld", 1);
    EffectAuthority effects = new EffectAuthority("session", "world", 1);
    effects.bind(profile, 1, space, null);
    long readGeneration = effects.cancellationGeneration();
    InventoryObservationRead read = new InventoryObservationRead(
        10, readGeneration, connection, player, world, 1, space, profile);
    EffectAuthority.Scope effectScope = new EffectAuthority.Scope("session", "world", 1,
        effects.nativeBootId(), "run", 1, 1, 1, "execution", "b".repeat(64));
    EffectAuthority.Owner producer = new EffectAuthority.Owner("producer", effectScope, readGeneration);
    require(effects.grant(producer, profile, EffectAuthority.ScreenPrecondition.absent())
        == EffectAuthority.Rejection.NONE, "read/producer overlap was not admitted");
    require(effects.close(producer) && effects.cancellationGeneration() != readGeneration,
        "producer retirement did not advance effect authority");
    require(read.accepts(readGeneration, connection, player, world, 1, space, profile),
        "ordinary observation lost its exact receipt during producer retirement");
    require(!read.accepts(effects.cancellationGeneration(), connection, player, world, 1, space, profile),
        "a different receipt generation was relabelled as the pending read");
    require(!read.accepts(readGeneration, new Object(), player, world, 1, space, profile),
        "old connection receipt reached a replacement connection");
    require(!read.accepts(readGeneration, connection, new Object(), world, 1, space, profile),
        "old player receipt reached a replacement player");
    require(!read.accepts(readGeneration, connection, player, new Object(), 1, space, profile),
        "old world receipt reached a replacement client world");
    require(!read.accepts(readGeneration, connection, player, world, 2, space, profile),
        "old health/inventory receipt reached a different life");
    require(!read.accepts(readGeneration, connection, player, world, 1,
        new EffectAuthority.Space("minecraft:the_nether", 1), profile),
        "old receipt crossed dimensions");
    require(!read.accepts(readGeneration, connection, player, world, 1,
        new EffectAuthority.Space("minecraft:overworld", 2), profile),
        "old receipt crossed an authoritative relocation");
    require(!read.accepts(readGeneration, connection, player, world, 1, null, profile)
        && !read.accepts(readGeneration, connection, player, world, 1, space, "c".repeat(64)),
        "loading or changed profile retained old observation custody");
    VoxelVisibility ray = new VoxelVisibility();
    VoxelVisibility.Cells air = (x, y, z) -> 0;
    require(ray.clear(.5, .5, .5, 3.5, .5, .5, 3, 0, 0, air), "clear ray blocked");
    require(
        !ray.clear(.5, .5, .5, 3.5, .5, .5, 3, 0, 0, (x, y, z) -> x == 1 ? 1 : 0),
        "partial/fluid nonair cell did not occlude");
    require(
        !ray.clear(.5, .5, .5, 3.5, .5, .5, 3, 0, 0, (x, y, z) -> x == 1 ? -1 : 0),
        "unknown cell treated as air");
    require(
        ray.clear(.5, .5, .5, 3.5, .5, .5, 3, 0, 0, (x, y, z) -> x == 3 ? 1 : 0),
        "target cell not exempt");
    require(
        !ray.clear(.5, .5, .5, 2.5, 2.5, .5, 2, 2, 0, (x, y, z) -> x == 1 && y == 0 ? 1 : 0),
        "closed corner-contact voxel skipped");
    require(
        !ray.clear(1, .5, .5, 1, 2.5, .5, 1, 2, 0, (x, y, z) -> x == 0 && y == 1 ? 1 : 0),
        "coplanar neighboring voxel skipped");
    Object owner = new Object(), target = new Object();
    DamageAttribution hit = new DamageAttribution(owner, target);
    require(hit.outcome() == 2, "missing damage return became authoritative no damage");
    hit.begin(target, owner);
    hit.record(target, owner, false);
    require(hit.outcome() == 0, "prior-hurt/invulnerable rejected hit confirmed");
    hit.begin(target, owner);
    hit.record(target, owner, true);
    hit.begin(target, owner);
    hit.record(target, owner, false);
    require(hit.outcome() == 1, "new owned damage not retained");
    DamageAttribution foreign = new DamageAttribution(owner, target);
    Object other = new Object();
    foreign.begin(target, other);
    foreign.record(target, other, true);
    foreign.begin(target, owner);
    foreign.record(target, owner, true);
    require(foreign.outcome() == 2, "foreign damage stack became exact owned attribution");
    DamageAttribution differentTarget = new DamageAttribution(owner, target);
    differentTarget.begin(other, owner);
    differentTarget.record(other, owner, false);
    require(differentTarget.outcome() == 2, "different target produced authoritative rejection");
    DamageAttribution nested = new DamageAttribution(owner, target);
    nested.begin(target, owner);
    nested.begin(target, owner);
    nested.record(target, owner, true);
    nested.record(target, owner, false);
    require(nested.outcome() == 2, "nested damage returns became exact attribution");
    DamageAttribution interruptedDamage = new DamageAttribution(owner, target);
    interruptedDamage.begin(target, owner);
    require(interruptedDamage.outcome() == 2, "pending/exceptional damage became a terminal outcome");
    DamageAttribution orphanReturn = new DamageAttribution(owner, target);
    orphanReturn.record(target, owner, false);
    require(orphanReturn.outcome() == 2, "unmatched damage return became an owned rejection");
    require(
        EffectOutcome.deadline(EffectOutcome.WORLD_EFFECT).equals("unknown"),
        "lost emitted receipt became recoverable failed");
    require(EffectOutcome.deadline(0).equals("failed"), "undispatched action not known failed");
    require(
        EffectOutcome.close("failed", EffectOutcome.WORLD_EFFECT, false).equals("unknown"),
        "unconfirmed emitted failure retryable");
    require(
        EffectOutcome.close("failed", EffectOutcome.WORLD_EFFECT, true).equals("failed"),
        "authoritative rejection not retained");
    require(EffectOutcome.close("failed", EffectOutcome.CAMERA, false).equals("failed"),
        "aim-only interaction rejection became an unknown world mutation");
    require(EffectOutcome.deadline(EffectOutcome.CAMERA).equals("failed"),
        "camera-only deadline invented uncertain world effects");
    require(EffectOutcome.close("cancelled", EffectOutcome.CAMERA, false).equals("cancelled"),
        "neutralized camera cancellation invented uncertain world effects");
    int aimedThenEmitted = EffectOutcome.CAMERA | EffectOutcome.WORLD_EFFECT;
    require(EffectOutcome.close("failed", aimedThenEmitted, false).equals("unknown"),
        "interaction loss after actual emission became retryable because camera also moved");
    require(EffectOutcome.close("cancelled", EffectOutcome.WORLD_EFFECT, false).equals("unknown"),
        "movement cancellation without confirmation became a known effect outcome");
    require(EffectOutcome.deadline(aimedThenEmitted).equals("unknown"),
        "death/deadline after actual emission lost effect uncertainty");
    PlayerLifecycle entry = new PlayerLifecycle();
    require(
        entry.update(true, false, 0) == PlayerLifecycle.Decision.WAIT,
        "default client health admitted before authoritative state");
    require(
        entry.update(false, true, 1) == PlayerLifecycle.Decision.DIED,
        "saved-dead player was not observable as dead");
    require(
        entry.update(false, true, 2) == PlayerLifecycle.Decision.DIED,
        "saved-dead session automatically respawned");
    require(
        entry.update(true, true, 3) == PlayerLifecycle.Decision.DIED,
        "late health resurrected a dead life without explicit admission");
    require(!entry.beginRespawn(entry.lifeId(), false, 3), "respawn bypassed vanilla readiness");
    require(!entry.beginRespawn(entry.lifeId() + 1, true, 3), "stale life admitted respawn");
    require(entry.beginRespawn(1, true, 4), "explicit ready respawn was not admitted");
    require(!entry.beginRespawn(1, true, 4), "same respawn was emitted twice");
    require(!entry.confirmRespawn(true), "default health admitted a replacement");
    entry.update(true, true, 6);
    require(!entry.confirmRespawn(true), "old-player health admitted a replacement");
    entry.playerReplaced();
    require(!entry.confirmRespawn(true), "replacement without fresh health admitted");
    entry.update(true, true, 8);
    require(!entry.confirmRespawn(true), "replacement without position readiness admitted");
    entry.positionReceived();
    require(
        entry.confirmRespawn(true) && entry.ready() && entry.lifeId() == 2,
        "fresh health/pose/server receipt did not establish exactly one new life");
    require(
        entry.update(false, true, 10) == PlayerLifecycle.Decision.DIED && !entry.ready() && entry.lifeId() == 2,
        "admitted-session death did not fence");
    require(
        entry.update(false, true, 11) == PlayerLifecycle.Decision.DIED,
        "normal death entered automatic respawn");
    require(
        entry.update(true, true, 12) == PlayerLifecycle.Decision.DIED,
        "late alive update resurrected fenced authority");
    PlayerLifecycle fresh = new PlayerLifecycle();
    require(
        fresh.update(true, true, 0) == PlayerLifecycle.Decision.READY && fresh.lifeId() == 1,
        "initial authoritative alive life was not admitted");
    fresh.update(false, true, 1);
    require(fresh.beginRespawn(1, true, 2), "second-life recovery not admitted");
    require(
        fresh.update(false, false, 10002) == PlayerLifecycle.Decision.RESPAWN_FAILED,
        "ordinary respawn wait was unbounded");
    require(!fresh.confirmRespawn(true), "expired respawn replay admitted");
    require(!fresh.beginRespawn(1, true, 10003), "uncertain respawn request was replayed");
    require(fresh.update(true, false, 10004) == PlayerLifecycle.Decision.WAIT,
        "respawn timeout was repeatedly reported or predicted health admitted");
    fresh.playerReplaced();
    fresh.positionReceived();
    fresh.update(true, true, 10005);
    require(fresh.confirmRespawn(true) && fresh.lifeId() == 2,
        "late authoritative confirmation of the original request was discarded");
    require(entry.beginRespawn(2, true, 13), "repeated-life explicit recovery unavailable");
    entry.playerReplaced();
    entry.positionReceived();
    entry.update(true, true, 14);
    require(entry.confirmRespawn(true) && entry.lifeId() == 3, "third life was not distinct");
    PlayerLifecycle interrupted = new PlayerLifecycle();
    interrupted.update(true, true, 0);
    interrupted.update(false, true, 1);
    require(interrupted.beginRespawn(1, true, 2), "replacement-death scenario was not admitted");
    interrupted.playerReplaced();
    interrupted.positionReceived();
    interrupted.update(true, true, 3);
    require(interrupted.update(false, true, 4) == PlayerLifecycle.Decision.DIED
        && interrupted.lifeId() == 2 && interrupted.status() == PlayerLifecycle.Status.DEAD,
        "authoritative replacement death before custom receipt wedged recovery");
    require(!interrupted.confirmRespawn(true), "late positive receipt revived the dead replacement");
    require(interrupted.update(true, true, 5) == PlayerLifecycle.Decision.DIED
        && interrupted.lifeId() == 2, "late health reused the replacement incarnation");
    require(!interrupted.beginRespawn(1, true, 6), "old-life respawn replay admitted");
    require(interrupted.beginRespawn(2, true, 6), "explicit recovery of the dead replacement denied");
    interrupted.playerReplaced();
    interrupted.positionReceived();
    interrupted.update(true, true, 7);
    require(interrupted.confirmRespawn(true) && interrupted.lifeId() == 3,
        "fresh explicit replacement recovery did not establish a distinct life");
    PlayerLifecycle latePosition = new PlayerLifecycle();
    latePosition.update(false, true, 0);
    latePosition.beginRespawn(1, true, 1);
    latePosition.playerReplaced();
    latePosition.update(true, true, 2);
    require(latePosition.update(false, true, 3) == PlayerLifecycle.Decision.WAIT,
        "replacement without pose was prematurely admitted");
    require(!latePosition.confirmRespawn(true), "dead replacement accepted a stale alive receipt");
    latePosition.positionReceived();
    require(latePosition.update(false, false, 4) == PlayerLifecycle.Decision.DIED
        && latePosition.lifeId() == 2, "late pose discarded the recorded authoritative replacement death");
    System.out.println(
        "Native boundary regression PASS: sound allowlist/grouping/expiry/bins, conservative voxel"
            + " occlusion, exact damage attribution, uncertain deadlines, authoritative"
            + " alive/death/explicit-respawn lifecycle.");
  }
}
