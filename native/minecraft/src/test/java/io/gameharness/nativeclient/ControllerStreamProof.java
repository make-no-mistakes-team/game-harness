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
    preparationTraceOpportunities();
    preparationTraceBoundsAndOmissions();
    preparationTraceReadiness();
    preparationTraceHookIdentities();
    preparationTraceStreamingAndCursor();
    System.out.println("Native controller queue/age/lease proof passed");
  }
  private static void preparationTraceHookIdentities() {
    var trace = trace(4);
    trace.hook(NativePreparationTrace.Kind.SAMPLE_RENDER, NativePreparationTrace.Outcome.OBSERVED,
        1, 7, 3, 41, 0, 0, 3, 3, 20);
    trace.hook(NativePreparationTrace.Kind.SAMPLE_RENDER, NativePreparationTrace.Outcome.PASSED,
        2, 7, 3, 41, 0, 91, 1, 1, 24);
    var batch = trace.batch(4);
    var before = batch.events().get(0).wire();
    var captured = batch.events().get(1).wire();
    require(before.get("request_id").getAsString().equals("41")
        && before.get("sequence").isJsonNull() && before.get("frame_sequence").isJsonNull()
        && captured.get("request_id").getAsString().equals("41")
        && captured.get("sequence").isJsonNull()
        && captured.get("frame_sequence").getAsString().equals("91"),
        "pending read fabricated a capture identity or successful capture lost its actual identity");
    require(trace.batch(4) == batch && trace.finalBatch() == null,
        "uncommitted writer prefix was replaced by a final snapshot");
    require(trace.acknowledge(batch) && trace.seal(), "committed prefix could not retire");
    var terminal = trace.finalBatch();
    require(terminal.events().isEmpty() && terminal.counts().drained() == 2
        && terminal.wire().get("complete").getAsBoolean(),
        "later ordinary final carrier lost the already committed prefix");
  }

  private static void preparationTraceStreamingAndCursor() {
    long now = 1_000_000_000L;
    var queue = new ControllerInputQueue(now + 10_000_000_000L, now);
    try {
      require(!java.lang.reflect.Modifier.isSynchronized(ControllerInputQueue.class
          .getMethod("preparationOrdinal").getModifiers())
          && java.lang.reflect.Modifier.isVolatile(ControllerInputQueue.class
              .getDeclaredField("preparationOrdinal").getModifiers()),
          "observational cursor can block on the input queue monitor or lacks visibility");
    } catch (ReflectiveOperationException error) {
      throw new AssertionError("observational cursor contract unavailable", error);
    }
    require(queue.preparationOrdinal() == 0 && queue.preparationOrdinal() == 0,
        "observing the cursor began a preparation opportunity");
    require(queue.begin(now, 1) == null && queue.preparationOrdinal() == 1,
        "actual empty queue opportunity did not advance the cursor exactly once");
    var trace = trace(4096);
    long received = 0;
    // More than the entire collector capacity: existing ordinary reply commits recycle space.
    for (int group = 0; group < 192; group++) {
      for (int event = 0; event < 64; event++)
        trace.hook(NativePreparationTrace.Kind.PREPARE_ENTRY, NativePreparationTrace.Outcome.OBSERVED,
            group * 64L + event, group, group, 0, 0, 0, 0, 0, 1);
      var batch = trace.batch(64);
      require(batch.events().size() == 64 && batch.counts().omitted() == 0,
          "streaming trace exhausted despite acknowledged ordinary carriers");
      for (var event : batch.events())
        require(event.eventseq() == ++received, "streaming collector evicted or duplicated an accepted prefix");
      require(trace.batch(64) == batch && trace.acknowledge(batch),
          "ordinary writer commit did not preserve and then acknowledge the exact prefix");
    }
    require(trace.seal(), "retired streaming collector did not seal");
    var terminal = trace.finalBatch();
    require(terminal.events().isEmpty() && terminal.counts().accepted() == received
        && terminal.counts().drained() == received && terminal.wire().get("complete").getAsBoolean(),
        "streaming final evidence concealed an omitted warmup prefix");
  }

  private static NativePreparationTrace trace(int capacity) {
    return new NativePreparationTrace(new NativePreparationTrace.Identity("proof-owner", 7, "proof-boot", "a".repeat(64)),
        capacity);
  }
  private static long field(NativePreparationTrace.Event event, String name) {
    return Long.parseLong(event.wire().get(name).getAsString());
  }
  private static void preparationTraceOpportunities() {
    long now = 1_000_000_000L;
    var trace = trace(32);
    var queue = new ControllerInputQueue(now + 1_000_000_000L, now);
    queue.bindTrace(trace);
    require(queue.begin(now, 1) == null, "empty traced opportunity invented an entry");
    var first = queue.admit(101, 1, 11, 1, now, 0, 0, input(false, false), now);
    require(queue.begin(now, 2) == first, "no-predecessor onset opportunity did not begin");
    var second = queue.admit(102, 2, 12, 2, now, 0, 0, input(false, false), now);
    queue.admit(103, 3, 13, 2, now, 0, 0, input(false, false), now);
    require(queue.begin(now, 3) == null, "trace permitted applying overlap");
    var completion = queue.complete(first, 0, 3, now);
    require(queue.begin(now + 1, 4) == second, "trace changed FIFO after completion");
    var batch = trace.batch(32);
    var events = batch.events();
    require(events.size() == 8 && events.get(0).outcome() == NativePreparationTrace.Outcome.EMPTY
        && field(events.get(0), "preparation_ordinal") == 1
        && field(events.get(0), "evaluated_mask") == 7
        && events.get(0).wire().get("head_sequence").isJsonNull(),
        "empty begin opportunity or its short-circuited freshness was lost");
    require(events.get(1).wire().get("predecessor_sequence").isJsonNull()
        && events.get(1).wire().get("applying_sequence").isJsonNull()
        && field(events.get(2), "head_sequence") == 1
        && field(events.get(2), "preparation_ordinal") == 2,
        "onset facts were inferred from a later queued predecessor");
    require(field(events.get(3), "applying_sequence") == 1
        && events.get(3).wire().get("predecessor_sequence").isJsonNull()
        && field(events.get(4), "predecessor_sequence") == 2
        && field(events.get(4), "head_sequence") == 2
        && field(events.get(5), "evaluated_mask") == 3,
        "actual pending predecessor or applying short circuit was not retained");
    require(field(events.get(6), "request_id") == 101 && field(events.get(6), "sequence") == 1
        && field(events.get(6), "frame_sequence") == 11
        && field(events.get(6), "applied_native_ns") == now
        && field(events.get(6), "diagnostic_completion_native_ns") == completion.settledNanos()
        && field(events.get(7), "last_completed_request_id") == 101
        && field(events.get(7), "last_completed_frame_sequence") == 11
        && field(events.get(7), "last_applied_native_ns") == now,
        "completion trace borrowed identity or retimed the authoritative ACK");
    require(trace.batch(1) == batch, "unacknowledged accepted prefix was silently replaced");
    trace.acknowledge(batch);
    var terminal = trace.finalBatch();
    require(terminal.events().isEmpty() && terminal.counts().retained() == 0
        && terminal.wire().get("complete").getAsBoolean(), "fully delivered terminal trace was not complete");
  }
  private static void preparationTraceBoundsAndOmissions() {
    var trace = trace(2);
    for (int i = 0; i < 4; i++) trace.hook(NativePreparationTrace.Kind.PREPARE_ENTRY,
        NativePreparationTrace.Outcome.OBSERVED, Long.MIN_VALUE + i, i, i, 0, 0, 0, 0, 0, 0);
    var batch = trace.batch(1);
    require(batch.counts().attempted() == 4 && batch.counts().accepted() == 2
        && batch.counts().omitted() == 2 && batch.counts().exhausted() == 2
        && batch.events().get(0).eventseq() == 1
        && field(batch.events().get(0), "native_ns") == Long.MIN_VALUE,
        "finite trace evicted a prefix, lost omissions, or narrowed the signed native clock");
    require(trace.finalBatch() == null, "final drain discarded an unacknowledged prefix");
    trace.acknowledge(batch);
    trace.hook(NativePreparationTrace.Kind.PREPARE_EXIT, NativePreparationTrace.Outcome.OBSERVED, 5, 5, 5,
        0, 0, 0, 0, 0, 0);
    var finalBatch = trace.finalBatch();
    require(finalBatch.events().size() == 2 && finalBatch.events().get(0).eventseq() == 2
        && finalBatch.events().get(1).eventseq() == 5 && finalBatch.counts().sealed()
        && !finalBatch.wire().get("complete").getAsBoolean(), "trace hid an omission gap or failed to reuse drained capacity");
    trace.acknowledge(finalBatch);
    trace.hook(NativePreparationTrace.Kind.PREPARE_ENTRY, NativePreparationTrace.Outcome.OBSERVED, 6, 6, 6,
        0, 0, 0, 0, 0, 0);
    var sealed = trace.finalBatch();
    require(sealed.counts().closedOmitted() == 1 && sealed.counts().omitted() == 3,
        "late producer silently disappeared after sealing");

    var suffix = trace(65);
    for (int i = 0; i < 65; i++) suffix.hook(NativePreparationTrace.Kind.PREPARE_ENTRY,
        NativePreparationTrace.Outcome.OBSERVED, i, i, i, 0, 0, 0, 0, 0, 0);
    var bounded = suffix.finalBatch();
    require(bounded.events().size() == 64 && bounded.wire().get("unattached_retained").getAsInt() == 1
        && !bounded.wire().get("complete").getAsBoolean(), "bounded final reply concealed an undelivered accepted suffix");

    long now = 1_000_000_000L;
    var boundedQueue = new ControllerInputQueue(now + 1_000_000_000L, now);
    boundedQueue.bindTrace(trace(1));
    for (int i = 1; i <= 4; i++) boundedQueue.admit(i, i, i, 1, now, 0, 0, input(false, false), now);
    rejected(() -> boundedQueue.admit(5, 5, 5, 1, now, 0, 0, input(false, false), now),
        "trace overflow changed the original four-frame bound");
    require(boundedQueue.fenced() && boundedQueue.begin(now, 2) == null,
        "trace overflow changed the original one-way input fence");
    var age = new ControllerInputQueue(now + 1_000_000_000L, now);
    var ageTrace = trace(8);
    age.bindTrace(ageTrace);
    age.admit(1, 1, 1, 1, now, 0, 0, input(false, false), now);
    require(age.begin(now + ControllerInputQueue.FRAME_AGE_NS + 1, 2) == null, "tracing relaxed 150ms freshness");
    require(ageTrace.batch(8).events().get(1).outcome() == NativePreparationTrace.Outcome.STALE,
        "stale original branch was not traced");
    var exactAge = new ControllerInputQueue(now + 1_000_000_000L, now);
    exactAge.bindTrace(trace(8));
    var exact = exactAge.admit(1, 1, 1, 1, now, 0, 0, input(false, false), now);
    require(exactAge.begin(now + ControllerInputQueue.FRAME_AGE_NS, 2) == exact,
        "tracing rejected the exact 150ms freshness endpoint");
    var lease = new ControllerInputQueue(now + 1_000_000_000L, now);
    var leaseTrace = trace(8);
    lease.bindTrace(leaseTrace);
    require(lease.begin(now + ControllerInputQueue.LEASE_NS, 2) == null && lease.fenced(),
        "tracing relaxed 250ms lease");
    require(field(leaseTrace.batch(8).events().get(0), "evaluated_mask") == NativePreparationTrace.EXPIRED,
        "expired begin invented skipped applying/head/freshness decisions");
    var stopped = new ControllerInputQueue(now + 1_000_000_000L, now);
    stopped.bindTrace(trace(8));
    stopped.retired("explicit_retirement", now);
    require(stopped.begin(now, 2) == null && stopped.fenced(), "tracing revived a stopped owner");
    var detached = new ControllerInputQueue(now + 1_000_000_000L, now);
    var detachedTrace = trace(8);
    detached.bindTrace(detachedTrace);
    require(detached.begin(now, 1) == null, "empty diagnostic queue fabricated input");
    detached.bindTrace(null);
    require(detached.begin(now, 2) == null && !detached.fenced() && detachedTrace.seal(),
        "passive unbinding changed input authority or failed to seal");
    var detachedFinal = detachedTrace.finalBatch();
    require(detachedFinal.events().size() == 1 && detachedFinal.counts().attempted() == 1,
        "detached queue continued producing into final evidence");
  }
  private static void preparationTraceReadiness() {
    var trace = trace(16);
    var phase = new ControllerSamplePhase();
    Object owner = new Object(), foreign = new Object();
    phase.open(owner, 4);
    phase.bindTrace(owner, trace);
    require(!phase.ready(owner, 5, false) && !phase.ready(foreign, 5, true)
        && !phase.ready(owner, 4, true) && phase.ready(owner, 5, true)
        && phase.sampled(owner, 5, true) && !phase.ready(owner, 5, true),
        "traced readiness consumed an opportunity or changed original sampling");
    phase.retirementRequested(owner);
    phase.revoke(owner);
    require(!phase.ready(owner, 6, false) && !phase.ready(owner, 6, true)
        && !phase.rejectionReady(owner), "trace bypassed Stop or its explicit reply barrier");
    var batch = trace.batch(16);
    var events = batch.events();
    require(events.size() == 8 && field(events.get(0), "evaluated_mask") == 1
        && events.get(0).outcome() == NativePreparationTrace.Outcome.NOT_RENDERED
        && field(events.get(1), "evaluated_mask") == 15
        && events.get(1).outcome() == NativePreparationTrace.Outcome.WRONG_OWNER
        && field(events.get(2), "evaluated_mask") == 31
        && events.get(2).outcome() == NativePreparationTrace.Outcome.NOT_NEW_TICK,
        "readiness trace replayed a skipped owner/progress predicate");
    require(field(events.get(3), "last_sampled_tick") == 4
        && field(events.get(4), "last_sampled_tick") == 4
        && (field(events.get(4), "state_mask") & NativePreparationTrace.FROM_SAMPLED) != 0
        && field(events.get(5), "last_sampled_tick") == 5,
        "sampled's production second readiness call was removed or conflated with the first");
    require(field(events.get(6), "evaluated_mask") == 1
        && field(events.get(7), "evaluated_mask") == 3
        && events.get(7).outcome() == NativePreparationTrace.Outcome.RETIRED,
        "retired readiness traced unexecuted owner/tick predicates");
    phase.retirementReplied(owner);
    require(phase.rejectionReady(owner), "passive trace withheld the genuine retirement reply");
    require(trace.acknowledge(batch), "single-threaded readiness batch failed to acknowledge");
    phase.bindTrace(owner, null);
    require(!phase.ready(owner, 6, true), "passive trace unbinding revived a retired owner");
    phase.open(foreign, 0);
    require(phase.ready(foreign, 1, true) && trace.seal() && trace.finalBatch().counts().attempted() == 8,
        "replacement owner inherited the previous trace identity");
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
