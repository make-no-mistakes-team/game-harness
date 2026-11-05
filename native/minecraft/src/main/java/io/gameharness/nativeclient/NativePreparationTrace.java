package io.gameharness.nativeclient;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/** Passive, finite diagnostics. Producers never wait, allocate events, serialize or perform I/O. */
public final class NativePreparationTrace {
  public static final int MAX_CAPACITY = 65_536, MAX_BATCH = 64;
  public enum Kind { ADMISSION, BEGIN, COMPLETION, APPLICATION_STAGE, SAMPLE_READY,
    PREPARE_ENTRY, PREPARE_EXIT, PREPARE_BRANCH, SAMPLE_RENDER;
    private final String wireName = name().toLowerCase(java.util.Locale.ROOT);
  }
  public enum Outcome { ADMITTED, ADMISSION_FAILED, EXPIRED, APPLYING, EMPTY, STALE, BEGAN,
    COMPLETED, STAGE, NOT_RENDERED, RETIRED, NO_OWNER, WRONG_OWNER, NOT_NEW_TICK, READY,
    OBSERVED, PASSED, BLOCKED;
    private final String wireName = name().toLowerCase(java.util.Locale.ROOT);
  }
  private static final Kind[] KINDS = Kind.values();
  private static final Outcome[] OUTCOMES = Outcome.values();
  // Kind-specific predicate bits: a value bit is meaningful ONLY when its evaluated bit is set.
  public static final long EXPIRED = 1, APPLYING = 2, HEAD_PRESENT = 4, STALE = 8;
  public static final long RENDERED = 1, RETIRED = 2, OWNER_PRESENT = 4, OWNER_MATCH = 8, NEW_TICK = 16;
  public static final long STATE_RETIRED = 1, STATE_RETIREMENT_PENDING = 2;
  public static final long FROM_SAMPLED = 32;
  private static final String[] FIELDS = {"eventseq", "native_ns", "checked_native_ns", "tick",
      "preparation_ordinal", "request_id", "sequence", "frame_sequence", "captured_native_ns",
      "pending_count", "head_request_id", "head_sequence", "head_frame_sequence",
      "predecessor_request_id", "predecessor_sequence", "predecessor_frame_sequence",
      "applying_request_id", "applying_sequence", "applying_frame_sequence",
      "last_completed_request_id", "last_completed_sequence", "last_completed_frame_sequence",
      "last_completed_tick", "last_applied_native_ns", "applied_native_ns", "diagnostic_completion_native_ns",
      "evaluated_mask", "value_mask", "last_sampled_tick", "state_mask", "stage"};
  private static final int WIDTH = FIELDS.length + 3;
  public record Identity(String ownerOperationId, long controllerGeneration, String nativeBootId, String sourceHash) {
    public Identity {
      ContractIdentity.id(ownerOperationId); ContractIdentity.checked(controllerGeneration);
      ContractIdentity.id(nativeBootId); ContractIdentity.hash(sourceHash);
    }
  }
  /** Consumer-owned immutable copy. Unavailable fields are null on the wire, not invented zeros. */
  public static final class Event {
    private final Kind kind;
    private final Outcome outcome;
    private final long[] values;
    private final long presentMask;
    private Event(Kind kind, Outcome outcome, long[] ownedValues, long presentMask) {
      this.kind = kind; this.outcome = outcome; values = ownedValues; this.presentMask = presentMask;
    }
    public Kind kind() { return kind; }
    public Outcome outcome() { return outcome; }
    public long eventseq() { return values[0]; }
    public JsonObject wire() {
      JsonObject result = new JsonObject();
      result.addProperty("kind", kind.wireName);
      result.addProperty("outcome", outcome.wireName);
      for (int i = 0; i < FIELDS.length; i++) {
        long value = values[i];
        if ((presentMask & (1L << i)) == 0) result.add(FIELDS[i], com.google.gson.JsonNull.INSTANCE);
        else result.addProperty(FIELDS[i], Long.toString(value));
      }
      return result;
    }
  }
  public record Counts(long attempted, long accepted, long omitted, long contended, long exhausted,
      long closedOmitted, long drained, int retained, boolean sealed) {}
  /** Counts are a concurrent observation, not a transaction across contended producers. */
  public record Batch(Identity identity, List<Event> events, Counts counts, boolean finalBatch) {
    public Batch { events = List.copyOf(events); }
    public JsonObject wire() {
      JsonObject result = new JsonObject(), context = new JsonObject(), totals = new JsonObject();
      result.addProperty("schema_version", 1);
      context.addProperty("owner_operation_id", identity.ownerOperationId());
      context.addProperty("controller_generation", Long.toString(identity.controllerGeneration()));
      context.addProperty("native_boot_id", identity.nativeBootId());
      context.addProperty("source_hash", identity.sourceHash());
      result.add("identity", context);
      totals.addProperty("attempted", Long.toString(counts.attempted()));
      totals.addProperty("accepted", Long.toString(counts.accepted()));
      totals.addProperty("omitted", Long.toString(counts.omitted()));
      totals.addProperty("contended", Long.toString(counts.contended()));
      totals.addProperty("exhausted", Long.toString(counts.exhausted()));
      totals.addProperty("closed_omitted", Long.toString(counts.closedOmitted()));
      totals.addProperty("drained", Long.toString(counts.drained()));
      totals.addProperty("retained", counts.retained());
      totals.addProperty("sealed", counts.sealed());
      result.add("counts", totals);
      result.addProperty("final_batch", finalBatch);
      result.addProperty("unattached_retained", counts.retained() - events.size());
      result.addProperty("counts_consistent", counts.attempted() == counts.accepted() + counts.omitted());
      result.addProperty("complete", finalBatch && counts.retained() == events.size() && counts.omitted() == 0
          && counts.attempted() == counts.accepted());
      JsonArray rows = new JsonArray();
      for (Event event : events) rows.add(event.wire());
      result.add("events", rows);
      return result;
    }
  }
  private final Identity identity;
  private final int capacity;
  private final long[] slots;
  private final ReentrantLock lock = new ReentrantLock();
  private final AtomicLong attempted = new AtomicLong(), contended = new AtomicLong();
  private long accepted, exhausted, closedOmitted, drained;
  private int head, size;
  private boolean sealed;
  private Batch outstanding;

  public NativePreparationTrace(Identity identity, int capacity) {
    if (identity == null || capacity < 1 || capacity > MAX_CAPACITY)
      throw new IllegalArgumentException("Trace identity and bounded capacity required");
    this.identity = identity; this.capacity = capacity;
    slots = new long[capacity * WIDTH];
  }
  public Identity identity() { return identity; }
  /** After all producer bindings have been removed, close without draining or attaching a reply.
   * False means busy: report final evidence unknown if no later existing ordinary reply can finish it.
   * Never add a query, wait, or enlarge a reserved retirement reply to obtain trace delivery. */
  public boolean seal() {
    if (!lock.tryLock()) return false;
    try { sealed = true; return true; }
    finally { lock.unlock(); }
  }

  /** Queue invokes this only after the original branch result exists. No predicates are replayed.
   * ADMISSION tick is the submitted observation/capture tick, not a resampled admission tick.
   * BEGIN/COMPLETION ticks are the actual game-thread decision/completion ticks. */
  public void queue(Kind kind, Outcome outcome, long nativeNanos, long checkedNanos, long tick, long ordinal,
      long requestId, long sequence, long frameSequence, long capturedNanos,
      int pending, ControllerInputQueue.Entry queueHead,
      ControllerInputQueue.Entry predecessor, ControllerInputQueue.Entry applying,
      long lastRequest, long lastSequence, long lastFrame, long lastTick, long lastAppliedNanos,
      long appliedNanos, long diagnosticCompletionNanos, long evaluated, long values, int stage) {
    int slot = beginOffer(kind, outcome, nativeNanos);
    if (slot < 0) return;
    try {
      put(slot, 2, checkedNanos); put(slot, 3, tick); put(slot, 4, ordinal);
      if (requestId != 0) {
        put(slot, 5, requestId); put(slot, 6, sequence); put(slot, 7, frameSequence); put(slot, 8, capturedNanos);
      }
      put(slot, 9, pending); entry(slot, 10, queueHead); entry(slot, 13, predecessor); entry(slot, 16, applying);
      if (lastSequence != 0) {
        put(slot, 19, lastRequest); put(slot, 20, lastSequence); put(slot, 21, lastFrame);
        put(slot, 22, lastTick); put(slot, 23, lastAppliedNanos);
      }
      if (kind == Kind.COMPLETION) { put(slot, 24, appliedNanos); put(slot, 25, diagnosticCompletionNanos); }
      put(slot, 26, evaluated); put(slot, 27, values); put(slot, 30, stage);
    } finally { lock.unlock(); }
  }
  public void readiness(Outcome outcome, long nativeNanos, long tick, long lastSampledTick,
      long evaluated, long values, long state) {
    int slot = beginOffer(Kind.SAMPLE_READY, outcome, nativeNanos);
    if (slot < 0) return;
    try {
      put(slot, 3, tick); put(slot, 26, evaluated); put(slot, 27, values);
      put(slot, 28, lastSampledTick); put(slot, 29, state);
    } finally { lock.unlock(); }
  }
  /** NativeClient supplies an already evaluated result; this API grants no execution capability.
   * For PREPARE_BRANCH/SAMPLE_RENDER, stage identifies the caller's fixed hook site;
   * evaluated/value masks describe only checks actually reached, with that site's documented bits. */
  public void hook(Kind kind, Outcome outcome, long nativeNanos, long tick, long preparationOrdinal,
      long requestId, long sequence, long frameSequence, long evaluated, long values, int stage) {
    int slot = beginOffer(kind, outcome, nativeNanos);
    if (slot < 0) return;
    try {
      put(slot, 3, tick); put(slot, 4, preparationOrdinal);
      if (requestId != 0) put(slot, 5, requestId);
      if (sequence != 0) put(slot, 6, sequence);
      if (frameSequence != 0) put(slot, 7, frameSequence);
      put(slot, 26, evaluated);
      put(slot, 27, values); put(slot, 30, stage);
    } finally { lock.unlock(); }
  }
  private int beginOffer(Kind kind, Outcome outcome, long nanos) {
    if (!lock.tryLock()) { attempted.incrementAndGet(); contended.incrementAndGet(); return -1; }
    long eventseq = attempted.incrementAndGet();
    if (sealed) { closedOmitted++; lock.unlock(); return -1; }
    if (size == capacity || eventseq <= 0) { exhausted++; lock.unlock(); return -1; }
    int slot = (head + size) % capacity;
    java.util.Arrays.fill(slots, slot * WIDTH, (slot + 1) * WIDTH, 0L);
    put(slot, 0, eventseq); put(slot, 1, nanos);
    slots[slot * WIDTH + FIELDS.length] = kind.ordinal();
    slots[slot * WIDTH + FIELDS.length + 1] = outcome.ordinal();
    size++; accepted++;
    return slot;
  }
  private void put(int slot, int field, long value) {
    slots[slot * WIDTH + field] = value;
    slots[slot * WIDTH + FIELDS.length + 2] |= 1L << field;
  }
  private void entry(int slot, int field, ControllerInputQueue.Entry entry) {
    if (entry != null) { put(slot, field, entry.requestId()); put(slot, field + 1, entry.sequence()); put(slot, field + 2, entry.frameSequence()); }
  }
  /** Consumer only, nonblocking: null means busy. Until successful acknowledge(), calls retain the same prefix. */
  public Batch batch(int maximum) {
    if (maximum < 1 || maximum > MAX_BATCH) throw new IllegalArgumentException("Invalid trace batch bound");
    if (!lock.tryLock()) return null;
    try { return snapshot(maximum, false); }
    finally { lock.unlock(); }
  }
  /** Consumer only, after producer retirement. Seals offers, returns at most 64 events.
   * The wire explicitly reports unattached_retained if a final reply cannot carry the entire suffix.
   * Null means busy or an unacknowledged earlier batch; neither condition permits waiting/retrying
   * on a new native call. The existing trusted reply must explicitly report missing final evidence. */
  public Batch finalBatch() {
    if (!lock.tryLock()) return null;
    try {
      if (outstanding != null) return null;
      return snapshot(MAX_BATCH, true);
    } finally { lock.unlock(); }
  }
  private Batch snapshot(int maximum, boolean seal) {
    if (outstanding != null) return outstanding;
    if (seal) sealed = true;
    int count = Math.min(maximum, size);
    List<Event> events = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      int offset = ((head + i) % capacity) * WIDTH;
      long[] values = new long[FIELDS.length];
      System.arraycopy(slots, offset, values, 0, FIELDS.length);
      events.add(new Event(KINDS[(int) slots[offset + FIELDS.length]],
          OUTCOMES[(int) slots[offset + FIELDS.length + 1]], values,
          slots[offset + FIELDS.length + 2]));
    }
    long attempts = attempted.get(), contention = contended.get();
    Counts counts = new Counts(attempts, accepted, contention + exhausted + closedOmitted,
        contention, exhausted, closedOmitted, drained, size, sealed);
    outstanding = new Batch(identity, events, counts, seal);
    return outstanding;
  }
  /** Call ONLY after that exact batch is committed to the existing trusted reply writer queue.
   * This is not OS/socket delivery evidence. False means busy/unknown and leaves the prefix intact.
   * Retain a committed-but-unacknowledged token, and retry its ack before attaching a later batch;
   * otherwise consumers must deduplicate repeated eventseq. No new native call or wait is allowed.
   * A failed serialization/send retains the prefix; abandoning it must be reported as unknown. */
  public boolean acknowledge(Batch batch) {
    if (!lock.tryLock()) return false;
    try {
      if (batch == null || batch != outstanding) return false;
      int count = batch.events().size();
      head = (head + count) % capacity; size -= count; drained += count; outstanding = null;
      return true;
    } finally { lock.unlock(); }
  }
}
