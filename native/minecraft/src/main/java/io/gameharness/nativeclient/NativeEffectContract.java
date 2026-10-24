package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.Set;

/** API4 authority codec. Historical API3 JSON is never decoded as a grant. */
public final class NativeEffectContract {
  private static final Set<String> SPACE_FIELDS = Set.of("dimension_id", "space_epoch");
  private static final Set<String> SCREEN_FIELDS = Set.of("screen_id", "incarnation", "revision");
  private static final Set<String> TARGET_FIELDS = Set.of("target_id", "incarnation", "space", "life_id");
  private static final Set<String> SCOPE_FIELDS = Set.of("session_id", "world_id", "epoch", "native_boot_id",
      "run_id", "run_generation", "life_id", "space_epoch", "execution_id", "source_hash");
  private static final Set<String> EFFECT_FIELDS = Set.of("operation_id", "compatibility_hash", "scope", "invocation", "action", "expected_screen");
  private static final Set<String> INVOCATION_FIELDS = Set.of("kind", "execution_id", "source_hash");
  private static final Set<String> POLICY_FIELDS = Set.of("kind", "execution_id", "source_hash", "policy_id", "version");
  private static final Set<String> OWNER_FIELDS = Set.of("operation_id", "scope", "generation");
  public record Received(EffectAuthority.Owner owner, String compatibilityHash,
      EffectAuthority.Screen expectedScreen, JsonObject action) {}
  private NativeEffectContract() {}

  public static long counter(JsonObject object, String key) {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException("Identity must be a JSON number: " + key);
    return ContractIdentity.counter(value.getAsJsonPrimitive().toString());
  }
  public static String id(JsonObject object, String key) {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
      throw new IllegalArgumentException("Identity must be a JSON string: " + key);
    return ContractIdentity.id(value.getAsString());
  }
  private static void fields(JsonObject object, Set<String> keys) {
    if (!object.keySet().equals(keys)) throw new IllegalArgumentException("Unknown or missing contract fields");
  }
  public static EffectAuthority.Space space(JsonObject value) {
    fields(value, SPACE_FIELDS);
    return new EffectAuthority.Space(id(value, "dimension_id"), counter(value, "space_epoch"));
  }
  public static EffectAuthority.Screen screen(JsonObject value) {
    fields(value, SCREEN_FIELDS);
    return new EffectAuthority.Screen(id(value, "screen_id"), counter(value, "incarnation"), counter(value, "revision"));
  }
  public static TargetIncarnations.Target target(JsonObject value) {
    fields(value, TARGET_FIELDS);
    return new TargetIncarnations.Target(id(value, "target_id"), counter(value, "incarnation"),
        space(value.getAsJsonObject("space")), counter(value, "life_id"));
  }
  public static EffectAuthority.Scope scope(JsonObject value) {
    fields(value, SCOPE_FIELDS);
    return new EffectAuthority.Scope(id(value, "session_id"), id(value, "world_id"), counter(value, "epoch"),
        id(value, "native_boot_id"), id(value, "run_id"), counter(value, "run_generation"),
        counter(value, "life_id"), counter(value, "space_epoch"), id(value, "execution_id"),
        ContractIdentity.hash(id(value, "source_hash")));
  }
  public static Received effect(JsonObject params, long cancellationGeneration) {
    fields(params, EFFECT_FIELDS);
    EffectAuthority.Scope scope = scope(params.getAsJsonObject("scope"));
    JsonObject invocation = params.getAsJsonObject("invocation");
    String kind = id(invocation, "kind");
    if (kind.equals("policy")) {
      fields(invocation, POLICY_FIELDS);
      id(invocation, "policy_id");
      if (counter(invocation, "version") == 0) throw new IllegalArgumentException("Policy version must be positive");
    } else {
      if (!kind.equals("skill") && !kind.equals("diagnostic")) throw new IllegalArgumentException("Unknown host invocation kind");
      fields(invocation, INVOCATION_FIELDS);
    }
    if (!scope.executionId().equals(id(invocation, "execution_id")) || !scope.sourceHash().equals(id(invocation, "source_hash")))
      throw new IllegalArgumentException("Invocation identity does not match its host-created scope");
    return new Received(new EffectAuthority.Owner(id(params, "operation_id"), scope, cancellationGeneration),
        ContractIdentity.hash(id(params, "compatibility_hash")),
        params.get("expected_screen").isJsonNull() ? null : screen(params.getAsJsonObject("expected_screen")),
        params.getAsJsonObject("action"));
  }
  public static EffectAuthority.Owner owner(JsonObject value) {
    fields(value, OWNER_FIELDS);
    return new EffectAuthority.Owner(id(value, "operation_id"), scope(value.getAsJsonObject("scope")), counter(value, "generation"));
  }
  public static JsonObject space(EffectAuthority.Space space) {
    JsonObject value = new JsonObject();
    value.addProperty("dimension_id", space.dimensionId()); value.addProperty("space_epoch", space.epoch());
    return value;
  }
  public static JsonElement screen(EffectAuthority.Screen screen) {
    if (screen == null) return JsonNull.INSTANCE;
    JsonObject value = new JsonObject();
    value.addProperty("screen_id", screen.id()); value.addProperty("incarnation", screen.incarnation()); value.addProperty("revision", screen.revision());
    return value;
  }
  public static JsonObject target(TargetIncarnations.Target target) {
    JsonObject value = new JsonObject();
    value.addProperty("target_id", target.targetId()); value.addProperty("incarnation", target.incarnation());
    value.addProperty("life_id", target.lifeId()); value.add("space", space(target.space()));
    return value;
  }
  public static JsonObject scope(EffectAuthority.Scope scope) {
    JsonObject value = new JsonObject();
    value.addProperty("session_id", scope.sessionId()); value.addProperty("world_id", scope.worldId());
    value.addProperty("epoch", scope.epoch()); value.addProperty("native_boot_id", scope.nativeBootId());
    value.addProperty("run_id", scope.runId()); value.addProperty("run_generation", scope.runGeneration());
    value.addProperty("life_id", scope.lifeId()); value.addProperty("space_epoch", scope.spaceEpoch());
    value.addProperty("execution_id", scope.executionId()); value.addProperty("source_hash", scope.sourceHash());
    return value;
  }
  public static JsonObject receipt(Received received, JsonObject result) {
    JsonObject value = new JsonObject();
    value.addProperty("operation_id", received.owner().operationId());
    value.addProperty("compatibility_hash", received.compatibilityHash());
    value.add("scope", scope(received.owner().scope())); value.add("result", result);
    return value;
  }
  public static JsonObject hello(JsonObject launch, JsonObject actualDescriptor, String nativeBootId) {
    JsonObject value = new JsonObject();
    value.addProperty("protocol", 3); value.addProperty("secret", ContractIdentity.hash(id(launch, "secret")));
    value.addProperty("session_id", id(launch, "session_id")); value.addProperty("world_id", id(launch, "world_id"));
    value.addProperty("epoch", counter(launch, "epoch")); value.addProperty("native_boot_id", ContractIdentity.id(nativeBootId));
    value.add("descriptor", actualDescriptor);
    return value;
  }
}
