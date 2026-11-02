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
  private long preparationOrdinal, beganNanos, beganTick, beganPreparationOrdinal;
  private long preparedNanos, consumedNanos, sampledNanos;
  private int stageMask;
  private boolean fenced;
  private String reason;
  private long firstFenceNanos;

  public ControllerInputQueue(long taskDeadline, long now) {
    if (taskDeadline <= now) throw new IllegalArgumentException("Controller task deadline expired");
    this.taskDeadline = taskDeadline;
    leaseDeadline = Math.min(taskDeadline, Math.addExact(now, LEASE_NS));
  }
  public synchronized Entry admit(long requestId, long sequence, long frameSequence, long observedTick,
      long capturedNanos, long edgeStart, long edgeEnd, JsonObject input, long now) {
    if (expired(now)) throw new IllegalStateException(reason);
    try {
      ContractIdentity.checked(requestId); ContractIdentity.checked(sequence); ContractIdentity.checked(frameSequence);
      ContractIdentity.checked(observedTick); ContractIdentity.checked(edgeStart); ContractIdentity.checked(edgeEnd);
      if (requestId == 0 || sequence <= submittedSequence || frameSequence <= submittedFrame)
        throw new IllegalArgumentException("Nonincreasing controller identity");
      if (capturedNanos > now || now - capturedNanos < 0 || now - capturedNanos > FRAME_AGE_NS)
        throw new IllegalArgumentException("Controller frame is stale or future");
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
      pending.addLast(entry);
      submittedSequence = sequence; submittedFrame = frameSequence; submittedEdges = edgeEnd;
      if (world != null) submittedHeld = world.heldMask();
      return entry;
    } catch (RuntimeException error) {
      fence("input_admission_failed: " + error.getMessage());
      throw error;
    }
  }
  public synchronized Entry begin(long now, long tick) {
    preparationOrdinal++;
    if (expired(now) || applying != null) return null;
    Entry next = pending.peekFirst();
    if (next == null) return null;
    if (now < next.capturedNanos() || now - next.capturedNanos() < 0 || now - next.capturedNanos() > FRAME_AGE_NS) {
      fence("queued_frame_expired_before_application");
      return null;
    }
    applying = pending.removeFirst();
    beganNanos = System.nanoTime(); beganTick = tick; beganPreparationOrdinal = preparationOrdinal;
    stageMask = 0; preparedNanos = consumedNanos = sampledNanos = 0;
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
  }
  public synchronized ApplicationCheck complete(Entry entry, long consumedPrefix, long tick, long now) {
    if (applying != entry || consumedPrefix < edgePrefix || consumedPrefix > entry.edgeEnd()
        || tick < appliedTick || appliedTick >= 0 && now < appliedNanos)
      throw new IllegalStateException("Invalid actual controller application");
    ApplicationCheck check = new ApplicationCheck(entry.sequence(), entry.frameSequence(), entry.admittedNanos(),
        entry.pendingAhead(), entry.applyingAheadSequence(), entry.admittedPreparationOrdinal(),
        beganNanos, beganTick, beganPreparationOrdinal, stageMask, preparedNanos, consumedNanos, sampledNanos, System.nanoTime(), tick);
    appliedSequence = entry.sequence(); edgePrefix = consumedPrefix; appliedTick = tick; appliedNanos = now; applying = null;
    return check;
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
