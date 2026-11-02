package io.gameharness.nativeclient;

/** One nonce, generation and handler; an uncertain transaction is retired, never replayed. */
public final class GuiReceiptFence {
  private int nonce, lastNonce, sync;
  private long generation;
  private int phase;
  public boolean arm(int nonce, long generation, int sync) {
    if (phase != 0 || nonce <= lastNonce || nonce <= 0 || generation < 0 || sync < 0) return false;
    this.nonce = nonce; lastNonce = nonce; this.generation = generation; this.sync = sync; phase = 1; return true;
  }
  public boolean accept(int nonce, long generation, int sync, String phase) {
    if (this.nonce != nonce || this.generation != generation || this.sync != sync) return false;
    if (this.phase == 1 && phase.equals("arm")) { this.phase = 2; return true; }
    if (this.phase == 3 && phase.equals("finish")) { this.phase = 0; return true; }
    return false;
  }
  public boolean finish() { if (phase != 2) return false; phase = 3; return true; }
  /** Revoke all ACK authority; true requests one diagnostic FINISH for an outstanding ARM. */
  public boolean revoke() {
    boolean outstanding = phase == 1 || phase == 2;
    phase = 0; nonce = 0;
    return outstanding;
  }
}
