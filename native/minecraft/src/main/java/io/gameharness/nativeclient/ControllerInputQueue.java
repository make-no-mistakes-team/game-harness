package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.Set;

/** One owner's bounded admission cursor. Only complete() records actual game-thread application. */
public final class ControllerInputQueue {
  public static final long FRAME_AGE_NS = 150_000_000L, LEASE_NS = 250_000_000L;
  public record Entry(long requestId, long sequence, long frameSequence, long observedTick, long capturedNanos,
      long edgeStart, long edgeEnd, WorldInputPlan.Step world, JsonObject screenAction,
      long admittedNanos, int pendingAhead, long applyingAheadSequence, long admittedPreparationOrdinal) {}
  /** Trusted stage facts, not an additional input/application authority. Missing stages have no timestamp. */
  public record ApplicationCheck(long sequence, long frameSequence, long admittedNanos, int pendingAhead,
      long applyingAheadSequence, long admittedPreparationOrdinal, long beganNanos, long beganTick,
      long beganPreparationOrdinal, int stageMask, long preparedNanos, long consumedNanos, long sampledNanos,
      long settledNanos, long settledTick) {}
  /** Immutable facts captured at the queue decision, never reconstructed at reply/application time. */
  public record LeaseCheck(String event, long checkedNanos, Long requestedDeadline, Long previousDeadline,
      long effectiveDeadline, long taskDeadline, boolean accepted, String firstFenceReason, Long firstFenceNanos,
      String retirementTrigger, Long retirementNanos, String rejection) {
    public void requireAccepted() {
      if (accepted) return;
      if (firstFenceReason != null) throw new IllegalStateException(rejection);
      throw new IllegalArgumentException(rejection);
    }
  }
  private final ArrayDeque<Entry> pending = new ArrayDeque<>(4);
  private final long taskDeadline;
  private long leaseDeadline, submittedSequence, submittedFrame, submittedEdges, appliedSequence, edgePrefix;
  private long appliedTick = -1, appliedNanos;
  private int submittedHeld;
  private Entry applying;
  private volatile long preparationOrdinal;
  private long beganNanos, beganTick, beganPreparationOrdinal;
  private long preparedNanos, consumedNanos, sampledNanos;
  private int stageMask;
  private boolean fenced;
  private String reason;
  private long firstFenceNanos;
  private NativePreparationTrace trace;
  private NativePreparationTrace boundTrace;
  private long completedRequestId, completedFrame;

  /** Explicit passive binding; null only detaches diagnostics, never fences/retires/drains input.
   * A nonnull binding cannot change this queue's diagnostic identity. */
  public synchronized void bindTrace(NativePreparationTrace trace) {
    if (trace == null) { this.trace = null; return; }
    if (boundTrace != null && boundTrace != trace)
      throw new IllegalArgumentException("Trace cannot change queue identity");
    boundTrace = this.trace = trace;
  }
  /** Observational cursor only; does not begin an opportunity or evaluate a gate. */
  public long preparationOrdinal() { return preparationOrdinal; }

  public ControllerInputQueue(long taskDeadline, long now) {
    if (taskDeadline <= now) throw new IllegalArgumentException("Controller task deadline expired");
    this.taskDeadline = taskDeadline;
    leaseDeadline = Math.min(taskDeadline, Math.addExact(now, LEASE_NS));
  }
  public synchronized Entry admit(long requestId, long sequence, long frameSequence, long observedTick,
      long capturedNanos, long edgeStart, long edgeEnd, JsonObject input, long now) {
    if (expired(now)) {
      traceAdmission(NativePreparationTrace.Outcome.EXPIRED, requestId, sequence, frameSequence, observedTick,
          capturedNanos, now, null, NativePreparationTrace.EXPIRED, NativePreparationTrace.EXPIRED);
      throw new IllegalStateException(reason);
    }
    long evaluated = NativePreparationTrace.EXPIRED, values = 0;
    try {
      ContractIdentity.checked(requestId); ContractIdentity.checked(sequence); ContractIdentity.checked(frameSequence);
      ContractIdentity.checked(observedTick); ContractIdentity.checked(edgeStart); ContractIdentity.checked(edgeEnd);
      if (requestId == 0 || sequence <= submittedSequence || frameSequence <= submittedFrame)
        throw new IllegalArgumentException("Nonincreasing controller identity");
      evaluated |= NativePreparationTrace.STALE;
      if (capturedNanos > now || now - capturedNanos < 0 || now - capturedNanos > FRAME_AGE_NS) {
        values |= NativePreparationTrace.STALE;
        throw new IllegalArgumentException("Controller frame is stale or future");
      }
      if (pending.size() + (applying == null ? 0 : 1) >= 4)
        throw new IllegalStateException("Controller frame capacity exceeded");
      WorldInputPlan.Step world = null;
      JsonObject screen = null;
      int edges;
      String kind = NativeEffectContract.id(input, "kind");
      if (kind.equals("world")) {
        world = WorldInputPlan.streamStep(input, submittedHeld);
        edges = world.expandedEdges();
      } else if (kind.equals("screen")) {
        if (!input.keySet().equals(Set.of("kind", "screen", "operations")) || submittedHeld != 0)
          throw new IllegalArgumentException("GUI stream requires neutral world input and exact fields");
        screen = new JsonObject();
        screen.addProperty("kind", "screen_input");
        screen.add("screen", input.get("screen")); screen.add("operations", input.get("operations"));
        edges = VisibleScreenContract.operations(screen).size();
      } else throw new IllegalArgumentException("Unknown controller input kind");
      if (edgeStart != submittedEdges || edgeEnd < edgeStart || edgeEnd - edgeStart != edges || edgeEnd - edgePrefix > 256)
        throw new IllegalArgumentException("Controller ordered edge capacity/range mismatch");
      Entry entry = new Entry(requestId, sequence, frameSequence, observedTick, capturedNanos, edgeStart, edgeEnd, world, screen,
          System.nanoTime(), pending.size(), applying == null ? 0 : applying.sequence(), preparationOrdinal);
      Entry predecessor = trace == null ? null : pending.peekLast();
      pending.addLast(entry);
      submittedSequence = sequence; submittedFrame = frameSequence; submittedEdges = edgeEnd;
      if (world != null) submittedHeld = world.heldMask();
      traceAdmission(NativePreparationTrace.Outcome.ADMITTED, requestId, sequence, frameSequence, observedTick,
          capturedNanos, now, predecessor, evaluated, values);
      return entry;
    } catch (RuntimeException error) {
      fence("input_admission_failed: " + error.getMessage());
      traceAdmission(NativePreparationTrace.Outcome.ADMISSION_FAILED, requestId, sequence, frameSequence, observedTick,
          capturedNanos, now, trace == null ? null : pending.peekLast(), evaluated, values);
      throw error;
    }
  }
  public synchronized Entry begin(long now, long tick) {
    preparationOrdinal++;
    if (expired(now)) {
      traceQueue(NativePreparationTrace.Kind.BEGIN, NativePreparationTrace.Outcome.EXPIRED, null, now, tick,
          NativePreparationTrace.EXPIRED, NativePreparationTrace.EXPIRED, 0, 0, 0);
      return null;
    }
    if (applying != null) {
      traceQueue(NativePreparationTrace.Kind.BEGIN, NativePreparationTrace.Outcome.APPLYING, applying, now, tick,
          NativePreparationTrace.EXPIRED | NativePreparationTrace.APPLYING, NativePreparationTrace.APPLYING, 0, 0, 0);
      return null;
    }
    Entry next = pending.peekFirst();
    if (next == null) {
      traceQueue(NativePreparationTrace.Kind.BEGIN, NativePreparationTrace.Outcome.EMPTY, null, now, tick, 7, 0, 0, 0, 0);
      return null;
    }
    if (now < next.capturedNanos() || now - next.capturedNanos() < 0 || now - next.capturedNanos() > FRAME_AGE_NS) {
      fence("queued_frame_expired_before_application");
      traceQueue(NativePreparationTrace.Kind.BEGIN, NativePreparationTrace.Outcome.STALE, next, now, tick,
          15, NativePreparationTrace.HEAD_PRESENT | NativePreparationTrace.STALE, 0, 0, 0);
      return null;
    }
    int pendingAtDecision = trace == null ? 0 : pending.size();
    applying = pending.removeFirst();
    beganNanos = System.nanoTime(); beganTick = tick; beganPreparationOrdinal = preparationOrdinal;
    stageMask = 0; preparedNanos = consumedNanos = sampledNanos = 0;
    if (trace != null) trace.queue(NativePreparationTrace.Kind.BEGIN, NativePreparationTrace.Outcome.BEGAN,
        System.nanoTime(), now, tick, preparationOrdinal, applying.requestId(), applying.sequence(),
        applying.frameSequence(), applying.capturedNanos(), pendingAtDecision, applying, null, null,
        completedRequestId, appliedSequence, completedFrame, appliedTick, appliedNanos,
        0, 0, 15, NativePreparationTrace.HEAD_PRESENT, 0);
    return applying;
  }
  /** The caller stamps the real hook completion; stale/non-applying entries cannot borrow a stage. */
  public synchronized void applicationStage(Entry entry, int stage, long nanos) {
    if (entry == null || entry != applying || (stageMask & stage) != 0) return;
    switch (stage) {
      case 1 -> preparedNanos = nanos;
      case 2 -> consumedNanos = nanos;
      case 4 -> sampledNanos = nanos;
      default -> throw new IllegalArgumentException("Unknown controller application stage");
    }
    stageMask |= stage;
    traceQueue(NativePreparationTrace.Kind.APPLICATION_STAGE, NativePreparationTrace.Outcome.STAGE, entry,
        nanos, beganTick, 0, 0, stage, 0, 0);
  }
  public synchronized ApplicationCheck complete(Entry entry, long consumedPrefix, long tick, long now) {
    if (applying != entry || consumedPrefix < edgePrefix || consumedPrefix > entry.edgeEnd()
        || tick < appliedTick || appliedTick >= 0 && now < appliedNanos)
      throw new IllegalStateException("Invalid actual controller application");
    ApplicationCheck check = new ApplicationCheck(entry.sequence(), entry.frameSequence(), entry.admittedNanos(),
        entry.pendingAhead(), entry.applyingAheadSequence(), entry.admittedPreparationOrdinal(),
        beganNanos, beganTick, beganPreparationOrdinal, stageMask, preparedNanos, consumedNanos, sampledNanos, System.nanoTime(), tick);
    traceQueue(NativePreparationTrace.Kind.COMPLETION, NativePreparationTrace.Outcome.COMPLETED, entry,
        now, tick, 0, 0, stageMask, now, check.settledNanos());
    appliedSequence = entry.sequence(); edgePrefix = consumedPrefix; appliedTick = tick; appliedNanos = now; applying = null;
    completedRequestId = entry.requestId(); completedFrame = entry.frameSequence();
    return check;
  }
  private void traceAdmission(NativePreparationTrace.Outcome outcome, long requestId, long sequence, long frame,
      long tick, long captured, long checked, Entry predecessor, long evaluated, long values) {
    if (trace == null) return;
    trace.queue(NativePreparationTrace.Kind.ADMISSION, outcome, System.nanoTime(), checked, tick, preparationOrdinal,
        requestId, sequence, frame, captured, pending.size(), pending.peekFirst(), predecessor, applying,
        completedRequestId, appliedSequence, completedFrame, appliedTick, appliedNanos, 0, 0, evaluated, values, 0);
  }
  private void traceQueue(NativePreparationTrace.Kind kind, NativePreparationTrace.Outcome outcome, Entry entry,
      long checked, long tick, long evaluated, long values, int stage, long applied, long diagnosticCompletion) {
    if (trace == null) return;
    trace.queue(kind, outcome, System.nanoTime(), checked, tick, preparationOrdinal,
        entry == null ? 0 : entry.requestId(), entry == null ? 0 : entry.sequence(),
        entry == null ? 0 : entry.frameSequence(), entry == null ? 0 : entry.capturedNanos(),
        pending.size(), pending.peekFirst(), null, applying,
        completedRequestId, appliedSequence, completedFrame, appliedTick, appliedNanos,
        applied, diagnosticCompletion, evaluated, values, stage);
  }
  public synchronized LeaseCheck opened(long now) {
    return leaseCheck("open", now, null, null, true, null, null, null);
  }
  public synchronized LeaseCheck heartbeat(long deadline, long now) {
    long previous = leaseDeadline;
    if (expired(now)) return leaseCheck("refused", now, deadline, previous, false, null, null, reason);
    if (deadline <= now || deadline > taskDeadline || deadline - now > LEASE_NS)
      return leaseCheck("refused", now, deadline, previous, false, null, null, "Invalid mechanical controller lease");
    leaseDeadline = Math.max(leaseDeadline, deadline);
    return leaseCheck("renew", now, deadline, previous, true, null, null, null);
  }
  /** An externally rejected, identity-matched request did not mutate either deadline. */
  public synchronized LeaseCheck refused(Long deadline, long now) {
    return leaseCheck("refused", now, deadline, leaseDeadline, false, null, null, reason);
  }
  public synchronized LeaseCheck retired(String trigger, long now) {
    fence(trigger);
    return leaseCheck("retirement", now, null, leaseDeadline, true, trigger, now, null);
  }
  private LeaseCheck leaseCheck(String event, long now, Long requested, Long previous, boolean accepted,
      String trigger, Long retirementNanos, String rejection) {
    return new LeaseCheck(event, now, requested, previous, leaseDeadline, taskDeadline, accepted,
        reason, reason == null ? null : firstFenceNanos, trigger, retirementNanos, rejection);
  }
  public synchronized boolean expired(long now) {
    if (!fenced && (now >= leaseDeadline || now >= taskDeadline)) fence("native_input_lease_expired");
    return fenced;
  }
  public synchronized void fence(String reason) {
    fenced = true;
    // Validation's caller sample can predate an intervening synchronized renewal.
    // This stamp describes the actual one-way transition, not that earlier sample.
    if (this.reason == null) { this.reason = reason; firstFenceNanos = System.nanoTime(); }
  }
  public synchronized boolean fenced() { return fenced; }
  public synchronized String reason() { return reason; }
  public synchronized long appliedSequence() { return appliedSequence; }
  public synchronized long edgePrefix() { return edgePrefix; }
  public synchronized long submittedEdges() { return submittedEdges; }
  public synchronized int retainedFrames() { return pending.size() + (applying == null ? 0 : 1); }
  /** Unresolved request identities are drained only after physical retirement; never replayed. */
  public synchronized Entry drain() {
    if (applying != null) { Entry entry = applying; applying = null; return entry; }
    return pending.pollFirst();
  }
}
