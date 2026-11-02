package io.gameharness.nativeclient;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/** Server-thread-only, dependency-free receipt and furnace provenance state. Never writes gameplay. */
public final class GuiProductionLedger {
  private GuiProductionLedger() {}
  public static final int LIMIT = 64;
  public static final long LEASE_NS = 75_000_000_000L;
  public record Production(String producer, String item, int count) {}
  public record Outcome(boolean confirmed, String reason, List<Production> productions) {
    static Outcome unknown(String reason) { return new Outcome(false, reason, List.of()); }
    static Outcome accepted() { return new Outcome(true, null, List.of()); }
  }

  public static final class Session {
    private final Object owner;
    private int lastNonce;
    private long lastGeneration;
    private int nonce, syncId;
    private long generation, armedAt;
    private Object handler;
    private String uncertainty;
    private ArrayList<Production> productions;

    public Session(Object owner) { this.owner = Objects.requireNonNull(owner); }

    public Outcome arm(int nonce, long generation, Object handler, int syncId, boolean alive, long now) {
      if (nonce <= 0 || generation <= 0 || generation > 9_007_199_254_740_991L || syncId < 0)
        return Outcome.unknown("invalid");
      if (nonce <= lastNonce || generation < lastGeneration) return Outcome.unknown("stale");
      lastNonce = nonce;
      lastGeneration = generation;
      if (this.handler != null) {
        String reason = expired(now) ? "stale" : "incomplete";
        retire();
        return Outcome.unknown(reason);
      }
      if (!alive) return Outcome.unknown("not_alive");
      if (handler == null) return Outcome.unknown("handler_changed");
      this.nonce = nonce;
      this.generation = generation;
      this.handler = handler;
      this.syncId = syncId;
      this.armedAt = now;
      this.productions = new ArrayList<>();
      return Outcome.accepted();
    }

    public void uncertain(String reason) {
      if (handler != null && (uncertainty == null || "overflow".equals(reason))) uncertainty = reason;
    }

    public void take(Object owner, Object handler, boolean resultSlot, String producer, String item, int count, boolean proven) {
      if (this.owner != owner || this.handler == null || this.handler != handler || !resultSlot) return;
      if (!proven) { uncertain("incomplete"); return; }
      if (count <= 0 || count > 4096 || item == null || item.length() > 256
          || producer == null || !(producer.equals("crafting") || producer.equals("smelting")
              || producer.equals("trading") || producer.equals("anvil"))) {
        uncertain("incomplete");
        return;
      }
      if (productions.size() == LIMIT) { uncertain("overflow"); return; }
      productions.add(new Production(producer, item, count));
    }

    public Outcome finish(int nonce, long generation, Object handler, int syncId, boolean alive, long now) {
      if (this.handler == null) return Outcome.unknown("lost");
      if (this.nonce != nonce || this.generation != generation) return Outcome.unknown("stale");
      String reason = !alive ? "not_alive"
          : this.handler != handler || this.syncId != syncId ? "handler_changed"
          : expired(now) ? "stale" : uncertainty;
      Outcome outcome = reason == null ? new Outcome(true, null, List.copyOf(productions)) : Outcome.unknown(reason);
      retire();
      return outcome;
    }

    private boolean expired(long now) { return now < armedAt || now - armedAt > LEASE_NS; }
    private void retire() { handler = null; productions = null; uncertainty = null; }
  }

  /** Attached to one actual furnace, not keyed by world positions or retained in a global map. */
  public static final class Furnace {
    private Object inputOwner;
    private String inputItem, outputItem;
    private int inputCount, outputCount, unknownOutput;
    private final Object[] owners = new Object[LIMIT];
    private final int[] amounts = new int[LIMIT];
    private int head, size;
    private boolean overflow;
    private Object insertion, insertingOwner;
    private String insertionItem;
    private int insertionBefore, insertionWritten;
    private boolean insertionContinued;

    public boolean overflowed() { return overflow; }

    /** The source is the exact ordinary click frame, never a caller-supplied ownership tag. */
    public void beginInput(Object source, Object owner, String item, int before) {
      if (insertion != null) invalidateInput();
      if (source == null || owner == null) return;
      insertion = source;
      insertingOwner = owner;
      insertionItem = item;
      insertionBefore = insertionWritten = before;
      insertionContinued = before == inputCount && Objects.equals(item, inputItem) && inputOwner == owner;
    }

    /** setStack always invalidates live attribution; only this bracket can retain its candidate. */
    public void setInput(Object source, String item, int after) {
      inputOwner = null;
      if (source == null || source != insertion || item == null || after <= insertionWritten
          || insertionItem != null && !Objects.equals(item, insertionItem)) {
        clearInsertion();
        return;
      }
      insertionItem = item;
      insertionWritten = after;
    }

    /** Credit only an exact-source insertion conserved against that player's inventory plus cursor. */
    public void endInput(Object source, String item, int after, int ownLoss, String output, int outputCount) {
      if (source == null || source != insertion) { invalidateInput(); return; }
      Object owner = insertingOwner;
      int before = insertionBefore, written = insertionWritten;
      String expectedItem = insertionItem;
      boolean continued = insertionContinued;
      clearInsertion();
      if (after == before && written == before && Objects.equals(item, expectedItem)) return;
      reconcileOutput(output, outputCount);
      if (before == 0 && outputCount == 0) overflow = false;
      int added = after - before;
      if (added > 0 && ownLoss == added && after >= written && item != null
          && (expectedItem == null || Objects.equals(item, expectedItem)) && (before == 0 || continued)) {
        inputOwner = owner;
        inputItem = item;
        inputCount = after;
      } else {
        inputOwner = null;
        inputItem = item;
        inputCount = after;
      }
    }

    /** Called only around successful vanilla craftRecipe, with actual before/after quantities. */
    public void recipe(String input, int beforeInput, int afterInput, String output, int beforeOutput, int afterOutput) {
      reconcileOutput(output, beforeOutput);
      Object owner = inputOwner;
      boolean proven = !overflow && owner != null && Objects.equals(inputItem, input)
          && inputCount == beforeInput && beforeInput - afterInput == 1
          && afterOutput > beforeOutput && afterOutput - beforeOutput <= 4096;
      inputCount = afterInput;
      if (!proven) inputOwner = null;
      int added = afterOutput - beforeOutput;
      outputItem = output;
      outputCount = afterOutput;
      if (added <= 0 || !proven) { unknownOutput = afterOutput; clearBatches(); return; }
      if (size == LIMIT) {
        overflow = true;
        unknownOutput = afterOutput;
        inputOwner = null;
        clearBatches();
        return;
      }
      int index = (head + size) % LIMIT;
      owners[index] = owner;
      amounts[index] = added;
      size++;
    }

    /** Retire every actual take, including takes by another player or outside an armed transaction. */
    public int take(Object owner, String item, int before, int count) {
      reconcileOutput(item, before);
      if (count <= 0 || count > before) { resetOutput(item, Math.max(0, before - count)); return 0; }
      int remaining = count;
      int unknown = Math.min(unknownOutput, remaining);
      unknownOutput -= unknown;
      remaining -= unknown;
      int proven = 0;
      while (remaining > 0 && size > 0) {
        int taken = Math.min(remaining, amounts[head]);
        if (!overflow && owners[head] == owner) proven += taken;
        amounts[head] -= taken;
        remaining -= taken;
        if (amounts[head] == 0) {
          owners[head] = null;
          head = (head + 1) % LIMIT;
          size--;
        }
      }
      outputCount = before - count;
      return proven;
    }

    /** Observe setStack before it writes; vanilla also writes EMPTY after removing a full result. */
    public void setOutput(int before, int after) {
      if (before == 0 && after == 0) return;
      invalidateOutput(null, after);
    }

    /** Any replacement/removal not observed at its source destroys, never manufactures, attribution. */
    public void invalidateInput() { inputOwner = null; clearInsertion(); }
    public void invalidateOutput(String item, int count) { resetOutput(item, count); }

    private void clearInsertion() {
      insertion = null;
      insertingOwner = null;
      insertionItem = null;
      insertionContinued = false;
    }

    private void reconcileOutput(String item, int count) {
      if (count != outputCount || count > 0 && !Objects.equals(item, outputItem)) resetOutput(item, count);
    }
    private void resetOutput(String item, int count) {
      outputItem = item;
      outputCount = Math.max(0, count);
      unknownOutput = outputCount;
      clearBatches();
    }
    private void clearBatches() {
      while (size > 0) { owners[head] = null; head = (head + 1) % LIMIT; size--; }
    }
  }
}
