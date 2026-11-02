package io.gameharness.nativeclient;

/** Sampling/rejection ordering only; this gate grants no input or lease authority. */
public final class ControllerSamplePhase {
  private Object owner;
  private long sampledTick;
  private boolean retired, retirementPending;

  public synchronized void open(Object owner, long tick) {
    if (owner == null) throw new IllegalArgumentException("Controller sample owner is required");
    ContractIdentity.checked(tick);
    this.owner = owner; sampledTick = tick;
    retired = retirementPending = false;
  }

  public synchronized boolean ready(Object expected, long tick, boolean rendered) {
    return rendered && !retired && owner != null && owner == expected && tick > sampledTick;
  }

  /** Called only after a genuine body was constructed and its original authority rechecked. */
  public synchronized boolean sampled(Object expected, long tick, boolean rendered) {
    if (!ready(expected, tick, rendered)) return false;
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
