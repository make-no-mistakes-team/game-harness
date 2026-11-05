package io.gameharness.nativeclient;

/** Sampling/rejection ordering only; this gate grants no input or lease authority. */
public final class ControllerSamplePhase {
  private Object owner;
  private long sampledTick;
  private boolean retired, retirementPending;
  private NativePreparationTrace trace;
  private NativePreparationTrace boundTrace;

  /** Bind immediately after open(), never across controller owner generations.
   * Null only detaches diagnostics and does not evaluate readiness or change retirement state. */
  public synchronized void bindTrace(Object expected, NativePreparationTrace trace) {
    if (trace == null) { this.trace = null; return; }
    if (owner != expected || expected == null || boundTrace != null && boundTrace != trace)
      throw new IllegalArgumentException("Sample trace requires its current owner");
    boundTrace = this.trace = trace;
  }

  public synchronized void open(Object owner, long tick) {
    if (owner == null) throw new IllegalArgumentException("Controller sample owner is required");
    ContractIdentity.checked(tick);
    this.owner = owner; sampledTick = tick;
    trace = boundTrace = null;
    retired = retirementPending = false;
  }

  public synchronized boolean ready(Object expected, long tick, boolean rendered) {
    return ready(expected, tick, rendered, false);
  }

  private boolean ready(Object expected, long tick, boolean rendered, boolean fromSampled) {
    if (trace == null) return rendered && !retired && owner != null && owner == expected && tick > sampledTick;
    // Same left-to-right short circuit as the original expression. Never replay for diagnostics.
    long evaluated = NativePreparationTrace.RENDERED, values = 0;
    NativePreparationTrace.Outcome outcome;
    if (!rendered) outcome = NativePreparationTrace.Outcome.NOT_RENDERED;
    else {
      values |= NativePreparationTrace.RENDERED;
      evaluated |= NativePreparationTrace.RETIRED;
      if (retired) {
        values |= NativePreparationTrace.RETIRED;
        outcome = NativePreparationTrace.Outcome.RETIRED;
      } else {
        evaluated |= NativePreparationTrace.OWNER_PRESENT;
        if (owner == null) outcome = NativePreparationTrace.Outcome.NO_OWNER;
        else {
          values |= NativePreparationTrace.OWNER_PRESENT;
          evaluated |= NativePreparationTrace.OWNER_MATCH;
          if (owner != expected) outcome = NativePreparationTrace.Outcome.WRONG_OWNER;
          else {
            values |= NativePreparationTrace.OWNER_MATCH;
            evaluated |= NativePreparationTrace.NEW_TICK;
            if (tick <= sampledTick) outcome = NativePreparationTrace.Outcome.NOT_NEW_TICK;
            else {
              values |= NativePreparationTrace.NEW_TICK;
              outcome = NativePreparationTrace.Outcome.READY;
            }
          }
        }
      }
    }
    if (trace != null) trace.readiness(outcome, System.nanoTime(), tick, sampledTick, evaluated, values,
        (retired ? NativePreparationTrace.STATE_RETIRED : 0)
            | (retirementPending ? NativePreparationTrace.STATE_RETIREMENT_PENDING : 0)
            | (fromSampled ? NativePreparationTrace.FROM_SAMPLED : 0));
    return outcome == NativePreparationTrace.Outcome.READY;
  }

  /** Called only after a genuine body was constructed and its original authority rechecked. */
  public synchronized boolean sampled(Object expected, long tick, boolean rendered) {
    if (!ready(expected, tick, rendered, true)) return false;
    sampledTick = ContractIdentity.checked(tick);
    return true;
  }

  /** Control-thread marker precedes its authority fence; no physical-release claim. */
  public synchronized void retirementRequested(Object expected) {
    if (owner == expected) retirementPending = true;
  }

  /** Game-thread physical release has completed. */
  public synchronized void revoke(Object expected) {
    if (owner == expected) retired = true;
  }

  /** The genuine explicit retirement reply has been queued. */
  public synchronized void retirementReplied(Object expected) {
    if (owner == expected) retirementPending = false;
  }

  public synchronized boolean rejectionReady(Object expected) {
    return owner != expected || retired && !retirementPending;
  }
}
