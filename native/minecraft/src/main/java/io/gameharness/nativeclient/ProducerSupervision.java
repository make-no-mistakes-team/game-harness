package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.util.Set;

/** Exact selected-child lease; renewal cannot resurrect an expired invocation. */
public final class ProducerSupervision {
  public final String sessionId;
  public final long behaviorGeneration;
  private long frameSequence, deadline;
  private boolean retired;

  public ProducerSupervision(JsonObject value) {
    NativeControllerContract.fields(value, Set.of("session_id", "behavior_generation", "frame_seq"));
    sessionId = NativeEffectContract.id(value, "session_id");
    behaviorGeneration = NativeEffectContract.counter(value, "behavior_generation");
    if (behaviorGeneration == 0) throw new IllegalArgumentException("Behavior generation must be positive");
    frameSequence = NativeEffectContract.counter(value, "frame_seq");
    if (frameSequence == 0) throw new IllegalArgumentException("Supervision frame must be positive");
  }

  public long frameSequence() { return frameSequence; }
  public long deadline() { return deadline; }

  public boolean admit(long captured, long now) {
    if (retired || now - captured < 0 || now - captured > ControllerInputQueue.FRAME_AGE_NS) return false;
    deadline = captured + ControllerInputQueue.LEASE_NS;
    return true;
  }

  public boolean renew(String session, long behavior, long frame, long captured, long now) {
    if (!current(now) || !sessionId.equals(session) || behaviorGeneration != behavior
        || frame <= frameSequence || now - captured < 0 || now - captured > ControllerInputQueue.FRAME_AGE_NS) return false;
    frameSequence = frame;
    deadline = captured + ControllerInputQueue.LEASE_NS;
    return true;
  }

  public boolean current(long now) {
    if (retired || deadline - now <= 0) { retired = true; return false; }
    return true;
  }
  public void retire() { retired = true; }
}
