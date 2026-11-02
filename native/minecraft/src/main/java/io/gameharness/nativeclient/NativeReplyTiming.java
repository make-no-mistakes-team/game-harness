package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import com.google.gson.JsonNull;
import java.util.HashMap;
import java.util.Map;

/** Request-owned clock stamps survive receive-stage rejection and delayed game-thread receipts. */
public final class NativeReplyTiming {
  private static final class Pending {
    final long receivedNanos;
    EffectAuthority.Owner owner;
    long controllerGeneration;
    ControllerInputQueue.LeaseCheck lease;
    ControllerInputQueue.ApplicationCheck application;
    Pending(long nanos) { receivedNanos = nanos; }
  }
  private final Map<Long, Pending> received = new HashMap<>();

  public synchronized void received(long requestId, long nanos) {
    received.put(requestId, new Pending(nanos));
  }

  public synchronized void controllerLease(long requestId, EffectAuthority.Owner owner, long generation,
      ControllerInputQueue.LeaseCheck lease) {
    Pending pending = received.get(requestId);
    if (pending == null || pending.lease != null || pending.application != null)
      throw new IllegalStateException("Controller lease timing request missing or already recorded");
    pending.owner = owner;
    pending.controllerGeneration = ContractIdentity.checked(generation);
    pending.lease = lease;
  }

  public synchronized void controllerApplication(long requestId, EffectAuthority.Owner owner, long generation,
      ControllerInputQueue.ApplicationCheck application) {
    Pending pending = received.get(requestId);
    if (pending == null || pending.lease != null || pending.application != null)
      throw new IllegalStateException("Controller application timing request missing or already recorded");
    pending.owner = owner;
    pending.controllerGeneration = ContractIdentity.checked(generation);
    pending.application = application;
  }

  public synchronized JsonObject replied(long requestId, String clockId, long nanos, long tick) {
    Pending pending = received.remove(requestId);
    if (pending == null) return null;
    JsonObject timing = new JsonObject();
    timing.addProperty("schema_version", 1);
    timing.addProperty("clock_id", clockId);
    timing.addProperty("received_ns", Long.toString(pending.receivedNanos));
    timing.addProperty("replied_ns", Long.toString(nanos));
    timing.addProperty("client_tick", ContractIdentity.checked(tick));
    if (pending.lease != null) {
      ControllerInputQueue.LeaseCheck check = pending.lease;
      JsonObject lease = new JsonObject();
      lease.addProperty("schema_version", 1);
      lease.addProperty("event", check.event());
      lease.add("owner", NativeControllerContract.owner(pending.owner));
      lease.addProperty("controller_generation", pending.controllerGeneration);
      lease.addProperty("checked_native_ns", Long.toString(check.checkedNanos()));
      nanos(lease, "requested_deadline_native_ns", check.requestedDeadline());
      nanos(lease, "previous_deadline_native_ns", check.previousDeadline());
      lease.addProperty("effective_deadline_native_ns", Long.toString(check.effectiveDeadline()));
      lease.addProperty("task_deadline_native_ns", Long.toString(check.taskDeadline()));
      lease.addProperty("accepted", check.accepted());
      lease.addProperty("first_fence_reason", check.firstFenceReason());
      nanos(lease, "first_fence_native_ns", check.firstFenceNanos());
      lease.addProperty("retirement_trigger", check.retirementTrigger());
      nanos(lease, "retirement_native_ns", check.retirementNanos());
      timing.add("controller_lease", lease);
    }
    if (pending.application != null) {
      var check = pending.application;
      JsonObject application = new JsonObject();
      application.addProperty("schema_version", 1);
      application.add("owner", NativeControllerContract.owner(pending.owner));
      application.addProperty("controller_generation", pending.controllerGeneration);
      application.addProperty("sequence", check.sequence());
      application.addProperty("frame_seq", check.frameSequence());
      application.addProperty("admitted_native_ns", Long.toString(check.admittedNanos()));
      application.addProperty("pending_ahead", check.pendingAhead());
      application.addProperty("applying_ahead_sequence", check.applyingAheadSequence());
      application.addProperty("admitted_preparation_ordinal", check.admittedPreparationOrdinal());
      application.addProperty("began_native_ns", Long.toString(check.beganNanos()));
      application.addProperty("began_native_tick", check.beganTick());
      application.addProperty("began_preparation_ordinal", check.beganPreparationOrdinal());
      stage(application, "prepared_native_ns", check.stageMask(), 1, check.preparedNanos());
      stage(application, "consumed_native_ns", check.stageMask(), 2, check.consumedNanos());
      stage(application, "sampled_native_ns", check.stageMask(), 4, check.sampledNanos());
      application.addProperty("settled_native_ns", Long.toString(check.settledNanos()));
      application.addProperty("settled_native_tick", check.settledTick());
      timing.add("controller_application", application);
    }
    return timing;
  }
  private static void stage(JsonObject object, String field, int mask, int flag, long value) {
    if ((mask & flag) == 0) object.add(field, JsonNull.INSTANCE);
    else object.addProperty(field, Long.toString(value));
  }
  private static void nanos(JsonObject object, String field, Long value) {
    if (value == null) object.add(field, JsonNull.INSTANCE);
    else object.addProperty(field, Long.toString(value));
  }
}
