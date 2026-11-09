package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.Set;

/** Sealed authority codec. Historical unsealed JSON is never decoded as a grant. */
public final class NativeEffectContract {
  private static final Set<String> SPACE_FIELDS = Set.of("dimension_id", "space_epoch");
  private static final Set<String> SCREEN_FIELDS = Set.of("screen_id", "incarnation", "revision");
  private static final Set<String> TARGET_FIELDS = Set.of("target_id", "incarnation", "space", "life_id");
  private static final Set<String> SCOPE_FIELDS = Set.of("session_id", "world_id", "epoch", "native_boot_id",
      "run_id", "run_generation", "life_id", "space_epoch", "execution_id", "source_hash");
  private static final Set<String> EFFECT_FIELDS = Set.of("operation_id", "compatibility_hash", "scope", "invocation", "action", "expected_screen");
  private static final Set<String> SUPERVISED_EFFECT_FIELDS =
      Set.of("operation_id", "compatibility_hash", "scope", "invocation", "action", "expected_screen", "supervision");
  private static final Set<String> INVOCATION_FIELDS = Set.of("kind", "execution_id", "source_hash");
  private static final Set<String> POLICY_FIELDS = Set.of("kind", "execution_id", "source_hash", "policy_id", "version");
  private static final Set<String> OWNER_FIELDS = Set.of("operation_id", "scope", "generation");
  public record Received(EffectAuthority.Owner owner, String compatibilityHash,
      EffectAuthority.ScreenPrecondition expectedScreen, JsonObject action, WorldInputPlan worldInput,
      ProducerSupervision supervision) {}
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
  public static EffectAuthority.VisibleScreenRef visibleScreen(JsonObject value) {
    fields(value, Set.of("screen_id", "incarnation", "layout_revision"));
    return new EffectAuthority.VisibleScreenRef(id(value, "screen_id"), counter(value, "incarnation"), counter(value, "layout_revision"));
  }
  public static EffectAuthority.ScreenPrecondition precondition(JsonObject value) {
    String kind = id(value, "kind");
    if (kind.equals("absent")) { fields(value, Set.of("kind")); return EffectAuthority.ScreenPrecondition.absent(); }
    fields(value, Set.of("kind", "screen"));
    if (kind.equals("transaction")) return EffectAuthority.ScreenPrecondition.transaction(screen(value.getAsJsonObject("screen")));
    if (kind.equals("layout")) return EffectAuthority.ScreenPrecondition.layout(visibleScreen(value.getAsJsonObject("screen")));
    throw new IllegalArgumentException("Unknown screen authority");
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
    fields(params, params.has("supervision") ? SUPERVISED_EFFECT_FIELDS : EFFECT_FIELDS);
    EffectAuthority.Scope scope = scope(params.getAsJsonObject("scope"));
    validateInvocation(scope, params.getAsJsonObject("invocation"));
    JsonObject action = params.getAsJsonObject("action");
    WorldInputPlan worldInput = id(action, "kind").equals("world_input") ? WorldInputPlan.decode(action) : null;
    EffectAuthority.ScreenPrecondition expectedScreen = precondition(params.getAsJsonObject("expected_screen"));
    if (worldInput != null && !expectedScreen.kind().equals("absent"))
      throw new IllegalArgumentException("World input requires explicit absence of a screen");
    if (id(action, "kind").equals("screen_input")) {
      VisibleScreenContract.operations(action);
      if (!expectedScreen.kind().equals("layout") || !visibleScreen(action.getAsJsonObject("screen")).equals(expectedScreen.layout()))
        throw new IllegalArgumentException("GUI input requires its exact layout precondition");
    } else if (expectedScreen.kind().equals("layout")) throw new IllegalArgumentException("Layout authority requires GUI input");
    return new Received(new EffectAuthority.Owner(id(params, "operation_id"), scope, cancellationGeneration),
        ContractIdentity.hash(id(params, "compatibility_hash")),
        expectedScreen,
        action, worldInput, params.has("supervision") ? new ProducerSupervision(params.getAsJsonObject("supervision")) : null);
  }

  static void validateInvocation(EffectAuthority.Scope scope, JsonObject invocation) {
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
  public static JsonObject visibleScreen(EffectAuthority.VisibleScreenRef screen) {
    JsonObject value = new JsonObject();
    value.addProperty("screen_id", screen.id()); value.addProperty("incarnation", screen.incarnation());
    value.addProperty("layout_revision", screen.layoutRevision()); return value;
  }
  public static JsonObject precondition(EffectAuthority.ScreenPrecondition screen) {
    JsonObject value = new JsonObject(); value.addProperty("kind", screen.kind());
    if (screen.transaction() != null) value.add("screen", screen(screen.transaction()));
    if (screen.layout() != null) value.add("screen", visibleScreen(screen.layout())); return value;
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
    value.addProperty("protocol", 4); value.addProperty("secret", ContractIdentity.hash(id(launch, "secret")));
    value.addProperty("session_id", id(launch, "session_id")); value.addProperty("world_id", id(launch, "world_id"));
    value.addProperty("epoch", counter(launch, "epoch")); value.addProperty("native_boot_id", ContractIdentity.id(nativeBootId));
    value.add("descriptor", actualDescriptor);
    return value;
  }
}
