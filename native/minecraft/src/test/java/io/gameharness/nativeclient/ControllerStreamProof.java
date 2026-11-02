package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** Native queue/lease evidence; actual vanilla consumption is separately exercised live. */
public final class ControllerStreamProof {
  private static void require(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }
  private static JsonObject input(boolean forward, boolean press) {
    return JsonParser.parseString("{\"kind\":\"world\",\"held\":{\"forward\":" + forward
        + ",\"back\":false,\"left\":false,\"right\":false,\"jump\":false,\"sprint\":false,\"sneak\":false,\"attack\":false,\"use\":false},"
        + "\"edges\":" + (press ? "[{\"kind\":\"button\",\"button\":\"forward\",\"phase\":\"press\",\"count\":1}]" : "[]")
        + ",\"view\":{\"kind\":\"unchanged\"},\"selected_hotbar\":null}").getAsJsonObject();
  }
  private static void rejected(Runnable work, String reason) {
    boolean rejected = false;
    try { work.run(); } catch (IllegalArgumentException | IllegalStateException expected) { rejected = true; }
    require(rejected, reason);
  }
  public static void main(String[] ignored) {
    long now = 1_000_000_000L;
    var queue = new ControllerInputQueue(now + 10_000_000_000L, now);
    var press = queue.admit(1, 1, 7, 4, now, 0, 1, input(true, true), now);
    var held = queue.admit(2, 2, 8, 4, now, 1, 1, input(true, false), now);
    require(queue.begin(now, 5) == press, "wire-ordered press lost before application");
    require(queue.begin(now, 5) == null, "second frame applied before first consumption completed");
    queue.complete(press, 1, 5, now + 1);
    require(queue.begin(now + 2, 6) == held, "held snapshot was not based on submitted-unacked press");
    queue.complete(held, 1, 6, now + 2);
    require(queue.appliedSequence() == 2 && queue.edgePrefix() == 1, "actual application counters diverged");
    require(!queue.expired(now + 249_999_999L), "lease expired before its bound");
    require(queue.expired(now + 250_000_000L), "lease was renewed by ordinary frame admission");
    rejected(() -> queue.admit(3, 3, 9, 6, now, 1, 1, input(true, false), now + 250_000_000L), "expired owner accepted input");

    var aged = new ControllerInputQueue(now + 10_000_000_000L, now);
    aged.admit(1, 1, 1, 1, now, 0, 1, input(true, true), now);
    require(aged.begin(now + 150_000_001L, 2) == null && aged.fenced(), "stalled native tick replayed stale press backlog");
    require(aged.appliedSequence() == 0 && aged.edgePrefix() == 0, "stale admission fabricated actual consumption");

    var boundary = new ControllerInputQueue(now + 10_000_000_000L, now);
    var exact = boundary.admit(1, 1, 1, 1, now - 150_000_000L, 0, 0, input(false, false), now);
    require(boundary.begin(now, 2) == exact, "exact maximum frame age refused");
    boundary.complete(exact, 0, 2, now);
    rejected(() -> boundary.admit(2, 2, 2, 2, now + 1, 0, 0, input(false, false), now), "future capture accepted");

    var transitions = new ControllerInputQueue(now + 10_000_000_000L, now);
    transitions.admit(1, 1, 1, 1, now, 0, 1, input(true, true), now);
    rejected(() -> transitions.admit(2, 2, 2, 1, now, 1, 1, input(false, false), now), "unexplained unacked held release admitted");

    var capacity = new ControllerInputQueue(now + 10_000_000_000L, now);
    for (int sequence = 1; sequence <= 4; sequence++) capacity.admit(sequence, sequence, sequence, 1, now, 0, 0, input(false, false), now);
    rejected(() -> capacity.admit(5, 5, 5, 1, now, 0, 0, input(false, false), now), "native queue exceeded four unresolved frames");
    require(capacity.fenced() && capacity.begin(now, 2) == null, "overflow did not fence queued ordinary effects");

    var renewal = new ControllerInputQueue(now + 300_000_000L, now);
    renewal.heartbeat(now + 300_000_000L, now + 100_000_000L).requireAccepted();
    require(!renewal.expired(now + 299_999_999L) && renewal.expired(now + 300_000_000L), "mechanical heartbeat extended root authority");
    rejected(() -> renewal.heartbeat(now + 400_000_000L, now + 300_000_000L).requireAccepted(), "expired native authority revived");
    leaseChronology();
    interleavedFenceChronology();
    applicationChronology();
    emptyGuiSettlementChronology();
    freshPostRenderSamples();
    sampleRejectionAfterRetirement();
    System.out.println("Native controller queue/age/lease proof passed");
  }
  private static void sampleRejectionAfterRetirement() {
    var phase = new ControllerSamplePhase();
    Object original = new Object(), replacement = new Object();
    phase.open(original, 1);
    require(!phase.rejectionReady(original), "live held input permitted an invalidation reply");
    phase.retirementRequested(original);
    phase.revoke(original);
    require(!phase.ready(original, 2, true) && !phase.rejectionReady(original),
        "physical release bypassed the pending explicit retirement reply");
    phase.retirementReplied(replacement);
    require(!phase.rejectionReady(original), "foreign reply released the original retirement barrier");
    phase.retirementReplied(original);
    require(phase.rejectionReady(original), "actual retirement reply did not release the waiting read");
    phase.open(replacement, 0);
    phase.retirementRequested(original);
    phase.revoke(original);
    require(!phase.rejectionReady(replacement) && phase.ready(replacement, 1, true),
        "old retirement invalidated a replacement owner");
    phase.revoke(replacement);
    require(phase.rejectionReady(replacement), "automatic physical retirement waited for a nonexistent revoke RPC");
  }
  private static void freshPostRenderSamples() {
    // Capturing before render or twice in a native tick must not prime a stale input pipeline.
    var phase = new ControllerSamplePhase();
    Object original = new Object(), replacement = new Object();
    require(!phase.ready(original, 1, true), "unopened stream obtained a resident sample");
    phase.open(original, 100);
    require(!phase.ready(original, 100, true) && !phase.ready(original, 101, false),
        "resident sample was fulfilled without both native progress and rendering");
    require(phase.ready(original, 101, true) && phase.ready(original, 101, true),
        "an observational readiness check consumed the sample opportunity");
    require(!phase.sampled(original, 101, false) && phase.sampled(original, 101, true),
        "a pre-render attempt advanced the resident sample cursor");
    require(!phase.ready(original, 101, true) && !phase.sampled(original, 101, true)
        && !phase.ready(original, 99, true), "same-tick or old-tick resident sample repeated");
    require(!phase.sampled(replacement, 102, true), "foreign owner borrowed the original sample cursor");
    phase.revoke(replacement);
    require(phase.ready(original, 102, true), "foreign retirement fenced the current sampling owner");
    phase.revoke(original);
    require(!phase.ready(original, 102, true), "retired stream obtained a fresh body reply");
    phase.open(replacement, 0);
    phase.revoke(original);
    require(phase.ready(replacement, 1, true) && !phase.sampled(original, 103, true),
        "replacement sampling inherited an old tick cursor or old-owner authority");
    require(phase.sampled(replacement, 1, true), "fresh owner lost its real post-render sample");
  }
  private static void emptyGuiSettlementChronology() {
    // Empty GUI snapshots preserve the caller's ACK time, sampled before dequeue.
    long callerSample = System.nanoTime();
    var queue = new ControllerInputQueue(callerSample + 2_000_000_000L, callerSample);
    JsonObject input = JsonParser.parseString("{\"kind\":\"screen\",\"screen\":{\"screen_id\":\"screen\","
        + "\"incarnation\":1,\"layout_revision\":1},\"operations\":[]}").getAsJsonObject();
    var empty = queue.admit(201, 1, 21, 8, callerSample, 0, 0, input, callerSample);
    require(queue.begin(callerSample, 9) == empty, "supported empty GUI snapshot did not begin");
    long lower = System.nanoTime();
    var check = queue.complete(empty, 0, 9, callerSample);
    long upper = System.nanoTime();
    require(check.settledNanos() >= lower && check.settledNanos() <= upper
        && check.settledNanos() >= check.beganNanos() && check.stageMask() == 0,
        "empty GUI diagnostic settlement predates actual begin or fabricates world hooks");
    var next = queue.admit(202, 2, 22, 9, callerSample, 0, 0, input, callerSample);
    require(queue.begin(callerSample + 1, 10) == next, "next empty GUI snapshot did not begin");
    // This is after the preserved ACK time but before the separate completion stamp.
    // Retiming the authoritative application cursor to the diagnostic clock would reject it.
    queue.complete(next, 0, 10, callerSample + 1);
    require(queue.appliedSequence() == 2 && queue.edgePrefix() == 0,
        "diagnostic settlement changed the authoritative application time/counters");
  }
  private static void applicationChronology() {
    // Catches admission/begin conflation, queue-depth guesses and later-entry stage borrowing.
    long origin = System.nanoTime();
    var queue = new ControllerInputQueue(origin + 2_000_000_000L, origin);
    var first = queue.admit(101, 1, 11, 7, origin, 0, 0, input(false, false), origin);
    require(queue.begin(System.nanoTime(), 8) == first, "first traced frame did not begin");
    var second = queue.admit(102, 2, 12, 8, origin, 0, 0, input(false, false), System.nanoTime());
    var third = queue.admit(103, 3, 13, 8, origin, 0, 0, input(false, false), System.nanoTime());
    require(queue.begin(System.nanoTime(), 9) == null, "diagnostics changed serial application");
    long prepared = System.nanoTime(), consumed = System.nanoTime(), sampled = System.nanoTime();
    queue.applicationStage(first, 1, prepared);
    queue.applicationStage(first, 2, consumed);
    queue.applicationStage(first, 4, sampled);
    var firstCheck = queue.complete(first, 0, 9, System.nanoTime());
    require(firstCheck.sequence() == 1 && firstCheck.frameSequence() == 11
        && firstCheck.pendingAhead() == 0 && firstCheck.applyingAheadSequence() == 0
        && firstCheck.admittedNanos() >= origin && firstCheck.beganNanos() >= firstCheck.admittedNanos()
        && firstCheck.beganTick() == 8 && firstCheck.settledTick() == 9
        && firstCheck.stageMask() == 7 && firstCheck.preparedNanos() == prepared
        && firstCheck.consumedNanos() == consumed && firstCheck.sampledNanos() == sampled,
        "application stage snapshot lost actual admission, begin or consumption facts");
    require(queue.begin(System.nanoTime(), 10) == second, "second traced frame did not begin");
    queue.applicationStage(first, 1, System.nanoTime());
    var secondCheck = queue.complete(second, 0, 10, System.nanoTime());
    require(secondCheck.pendingAhead() == 0 && secondCheck.applyingAheadSequence() == 1
        && secondCheck.admittedPreparationOrdinal() == 1 && secondCheck.beganPreparationOrdinal() == 3
        && secondCheck.stageMask() == 0 && secondCheck.beganNanos() >= firstCheck.settledNanos(),
        "queued wait was fabricated from reply order or borrowed another entry's stages");
    require(queue.begin(System.nanoTime(), 11) == third, "third traced frame did not begin");
    var thirdCheck = queue.complete(third, 0, 11, System.nanoTime());
    require(thirdCheck.pendingAhead() == 1 && thirdCheck.applyingAheadSequence() == 1
        && firstCheck.stageMask() == 7 && secondCheck.stageMask() == 0,
        "immutable admission depths or completed stage snapshots changed with later entries");
  }
  private static void interleavedFenceChronology() {
    // Recreate a pending frame and a caller sample taken before a later accepted renewal.
    // Queue history is explicit; only the transition timestamp uses the actual native clock.
    long origin = System.nanoTime(), capture = origin - 151_000_000L;
    var queue = new ControllerInputQueue(origin + 2_000_000_000L, capture);
    queue.admit(1, 1, 1, 1, capture, 0, 1, input(true, true), capture);
    long callerSample = System.nanoTime(), renewedAt = System.nanoTime();
    require(renewedAt > callerSample, "native clock failed to advance across the controlled renewal");
    var renewed = queue.heartbeat(renewedAt + 200_000_000L, renewedAt);
    renewed.requireAccepted();
    require(queue.begin(callerSample, 2) == null && queue.fenced(), "stale pending frame was not fenced");
    var after = queue.refused(null, System.nanoTime());
    require(after.firstFenceReason().equals("queued_frame_expired_before_application")
        && after.firstFenceNanos() >= renewed.checkedNanos(),
        "first-fence timestamp was backdated before an intervening accepted renewal");
    require(after.effectiveDeadline() == renewed.effectiveDeadline() && queue.appliedSequence() == 0,
        "chronology fix changed lease authority or fabricated input application");
  }
  private static void leaseChronology() {
    // Catches requested-deadline echo, post-reply resampling, renewal revival and clock narrowing.
    for (long origin : new long[] {-9_007_199_254_740_993L, 9_007_199_254_740_993L}) {
      var queue = new ControllerInputQueue(origin + 300_000_000L, origin);
      var opened = queue.opened(origin);
      require(opened.event().equals("open") && opened.accepted()
          && opened.requestedDeadline() == null && opened.previousDeadline() == null
          && opened.effectiveDeadline() == origin + 250_000_000L
          && opened.taskDeadline() == origin + 300_000_000L && opened.checkedNanos() == origin,
          "opening lost actual capped deadline or signed clock origin");
      var shorter = queue.heartbeat(origin + 200_000_000L, origin + 10_000_000L);
      require(shorter.accepted() && shorter.requestedDeadline() == origin + 200_000_000L
          && shorter.previousDeadline() == origin + 250_000_000L
          && shorter.effectiveDeadline() == origin + 250_000_000L,
          "accepted shorter heartbeat echoed requested deadline instead of actual effective lease");
      var extended = queue.heartbeat(origin + 300_000_000L, origin + 100_000_000L);
      require(extended.accepted() && extended.previousDeadline() == origin + 250_000_000L
          && extended.effectiveDeadline() == origin + 300_000_000L,
          "accepted heartbeat lost atomically extended lease");
      var invalid = queue.heartbeat(origin + 310_000_000L, origin + 110_000_000L);
      require(!invalid.accepted() && invalid.event().equals("refused")
          && invalid.previousDeadline() == origin + 300_000_000L
          && invalid.effectiveDeadline() == origin + 300_000_000L
          && invalid.taskDeadline() == origin + 300_000_000L && invalid.firstFenceReason() == null,
          "invalid heartbeat changed deadlines or invented a queue fence");
      rejected(invalid::requireAccepted, "invalid heartbeat reported success");
      long fenceLower = System.nanoTime();
      var expired = queue.heartbeat(origin + 400_000_000L, origin + 300_000_000L);
      long fenceUpper = System.nanoTime();
      require(!expired.accepted() && expired.effectiveDeadline() == origin + 300_000_000L
          && expired.firstFenceReason().equals("native_input_lease_expired")
          && expired.firstFenceNanos() >= fenceLower && expired.firstFenceNanos() <= fenceUpper,
          "expired heartbeat revived queue or failed to record the actual fence transition");
      rejected(expired::requireAccepted, "expired heartbeat reported success");
      var retired = queue.retired("explicit_retirement", origin + 400_000_000L);
      require(retired.event().equals("retirement") && retired.accepted()
          && retired.retirementTrigger().equals("explicit_retirement")
          && retired.retirementNanos() == origin + 400_000_000L
          && retired.firstFenceReason().equals("native_input_lease_expired")
          && retired.firstFenceNanos().equals(expired.firstFenceNanos()),
          "retirement rewrote first fence as its later trigger");
      require(opened.effectiveDeadline() == origin + 250_000_000L
          && opened.firstFenceReason() == null && shorter.effectiveDeadline() == origin + 250_000_000L,
          "later mutation changed earlier accepted diagnostic");
      var capped = new ControllerInputQueue(origin + 50_000_000L, origin).opened(origin);
      require(capped.effectiveDeadline() == origin + 50_000_000L,
          "opening reported 250ms instead of actual task-capped lease");
    }
    var fenced = new ControllerInputQueue(1_000_000_000L, 0);
    long fenceLower = System.nanoTime();
    fenced.fence("scope_changed");
    long fenceUpper = System.nanoTime();
    var refusal = fenced.refused(200_000_000L, 20);
    require(!refusal.accepted() && refusal.checkedNanos() == 20
        && refusal.firstFenceReason().equals("scope_changed")
        && refusal.firstFenceNanos() >= fenceLower && refusal.firstFenceNanos() <= fenceUpper,
        "external refusal lost first fence cause/time");
  }
}
