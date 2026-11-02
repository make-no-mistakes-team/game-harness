package io.gameharness.nativeclient;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.Set;

/** Broker-stamped controller authority; actor decisions cannot mint owner, clock or source fields. */
public final class NativeControllerContract {
  public record Grant(EffectAuthority.Owner owner, String compatibilityHash,
      EffectAuthority.ScreenPrecondition expectedScreen, long controllerGeneration, long taskDeadline) {}
  private NativeControllerContract() {}
  static void fields(JsonObject value, Set<String> fields) {
    if (value == null || !value.keySet().equals(fields)) throw new IllegalArgumentException("Unknown or missing controller fields");
  }
  public static long nanos(JsonObject value, String key) {
    JsonElement element = value.get(key);
    if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString())
      throw new IllegalArgumentException("Native time must be a signed decimal string");
    String text = element.getAsString();
    int first = text.startsWith("-") ? 1 : 0, digits = text.length() - first;
    if (digits < 1 || digits > 19 || digits > 1 && text.charAt(first) == '0')
      throw new IllegalArgumentException("Invalid native time digits");
    for (int index = first; index < text.length(); index++)
      if (text.charAt(index) < '0' || text.charAt(index) > '9') throw new IllegalArgumentException("Invalid native time digits");
    return Long.parseLong(text);
  }
  public static Grant grant(JsonObject value, long generation, long now) {
    fields(value, Set.of("owner", "compatibility_hash", "invocation", "expected_screen", "controller_generation", "deadline_native_ns", "clock_uncertainty_ms"));
    EffectAuthority.Owner owner = NativeEffectContract.owner(value.getAsJsonObject("owner"));
    if (owner.cancellationGeneration() != generation) throw new IllegalArgumentException("Controller native cancellation generation differs");
    NativeEffectContract.validateInvocation(owner.scope(), value.getAsJsonObject("invocation"));
    long controllerGeneration = NativeEffectContract.counter(value, "controller_generation"), deadline = nanos(value, "deadline_native_ns");
    JsonElement uncertainty = value.get("clock_uncertainty_ms");
    if (uncertainty == null || !uncertainty.isJsonPrimitive() || !uncertainty.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException("Controller clock uncertainty required");
    double error = uncertainty.getAsDouble();
    if (controllerGeneration == 0 || !Double.isFinite(error) || error < 0 || error > 150
        || deadline <= now || deadline - now < 0 || deadline - now > 16L * 60 * 60 * 1_000_000_000L)
      throw new IllegalArgumentException("Controller time/clock authority invalid");
    return new Grant(owner, ContractIdentity.hash(NativeEffectContract.id(value, "compatibility_hash")),
        NativeEffectContract.precondition(value.getAsJsonObject("expected_screen")), controllerGeneration, deadline);
  }
  public static void owner(JsonObject value, Grant grant) {
    if (!NativeEffectContract.owner(value.getAsJsonObject("owner")).equals(grant.owner())
        || NativeEffectContract.counter(value, "controller_generation") != grant.controllerGeneration())
      throw new IllegalArgumentException("Controller owner or generation differs");
  }
  public static JsonObject owner(EffectAuthority.Owner owner) {
    JsonObject value = new JsonObject(); value.addProperty("operation_id", owner.operationId());
    value.add("scope", NativeEffectContract.scope(owner.scope())); value.addProperty("generation", owner.cancellationGeneration());
    return value;
  }
}
