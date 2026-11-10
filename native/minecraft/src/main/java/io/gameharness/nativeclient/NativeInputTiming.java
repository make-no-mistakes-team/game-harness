package io.gameharness.nativeclient;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

/** Bounded per-owner application evidence; never a claim that the game confirmed an effect. */
public final class NativeInputTiming {
  private final String cameraPoint;

  public NativeInputTiming() { this("Motor.rotate/simulationTick+mouseTick/changeLookDirection"); }
  public NativeInputTiming(String cameraPoint) { this.cameraPoint = cameraPoint; }

  public static final class Samples {
    private long first, last, firstTick, lastTick, count;

    public void record(long nanos, long tick) {
      ContractIdentity.checked(tick);
      if (count == 0) { first = nanos; firstTick = tick; }
      last = nanos;
      lastTick = tick;
      count = ContractIdentity.next(count);
    }

    private JsonObject evidence(String point) {
      if (count == 0) return null;
      JsonObject value = new JsonObject();
      value.addProperty("point", point);
      value.addProperty("first_ns", Long.toString(first));
      value.addProperty("last_ns", Long.toString(last));
      value.addProperty("first_client_tick", firstTick);
      value.addProperty("last_client_tick", lastTick);
      value.addProperty("samples", count);
      return value;
    }
  }

  public final Samples keySample = new Samples();
  public final Samples cameraApply = new Samples();
  public final Samples keyRelease = new Samples();

  public JsonObject evidence(String clockId, long requestId, String operationId, long generation) {
    JsonObject value = new JsonObject();
    value.addProperty("schema_version", 1);
    value.addProperty("clock_id", clockId);
    value.addProperty("request_id", requestId);
    value.addProperty("operation_id", operationId);
    value.addProperty("generation", generation);
    JsonObject keys = keySample.evidence("KeyboardInput.tick/TAIL/playerInput");
    JsonObject camera = cameraApply.evidence(cameraPoint);
    JsonObject release = keyRelease.evidence("KeyBinding.setPressed/release");
    value.add("key_sample", keys == null ? JsonNull.INSTANCE : keys);
    value.add("camera_apply", camera == null ? JsonNull.INSTANCE : camera);
    value.add("key_release", release == null ? JsonNull.INSTANCE : release);
    return value;
  }
}
