package io.gameharness.nativeclient;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonParser;

/** Exercises the actual private launch decoder and one-shot owner-bound fault gate. */
public final class NativeEvaluationProof {
  private static final String HASH = "a".repeat(64);
  private static void require(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }
  private static NativeEvaluationConfig config(String json) {
    return NativeEvaluationConfig.read(JsonParser.parseString(json));
  }
  private static EffectAuthority.Owner owner(String operation, String source, long cancellation) {
    return new EffectAuthority.Owner(operation, new EffectAuthority.Scope("session", "world", 1,
        "boot", "run", 2, 3, 4, "execution", source), cancellation);
  }
  private static NativeEvaluationGate gate() {
    return new NativeEvaluationGate(config("{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null}"));
  }
  private static void invalid(JsonElement input, String reason) {
    boolean rejected = false;
    try { NativeEvaluationConfig.read(input); } catch (IllegalArgumentException expected) { rejected = true; }
    require(rejected, reason);
  }
  public static void main(String[] ignored) {
    strictLaunchDeclaration();
    disabledAndUnarmedDenial();
    exactPinnedIdentityAndSingleConsumption();
    cancellationNeverTransfers();
    invalidArmDoesNotSpendBoot();
  }
  private static void strictLaunchDeclaration() {
    require(NativeEvaluationConfig.read(JsonNull.INSTANCE) == null, "explicit null did not disable evaluation");
    invalid(null, "missing required session evaluation field accepted");
    for (String json : new String[] {
        "true", "[]", "1", "{}",
        "{\"version\":1,\"allow_inventory_replacement\":false,\"control_send_buffer_bytes\":null}",
        "{\"version\":2,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null}",
        "{\"version\":\"1\",\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null}",
        "{\"version\":1.5,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null}",
        "{\"version\":1,\"allow_inventory_replacement\":\"true\",\"control_send_buffer_bytes\":null}",
        "{\"version\":1,\"allow_inventory_replacement\":1,\"control_send_buffer_bytes\":null}",
        "{\"version\":1,\"allow_inventory_replacement\":null,\"control_send_buffer_bytes\":4096}",
        "{\"version\":1,\"allow_inventory_replacement\":true}",
        "{\"version\":1,\"control_send_buffer_bytes\":4096}",
        "{\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null,\"extra\":false}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":\"4096\"}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":true}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":4095}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":16385}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":4096.5}",
        "{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":1e999}"
    }) invalid(JsonParser.parseString(json), "malformed/coerced declaration accepted: " + json);
    for (double nonfinite : new double[] {Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
      var value = JsonParser.parseString("{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":4096}").getAsJsonObject();
      value.addProperty("control_send_buffer_bytes", nonfinite);
      invalid(value, "nonfinite native send buffer accepted");
    }
    for (int size : new int[] {4096, 8192, 16384}) {
      var socket = config("{\"version\":1,\"allow_inventory_replacement\":false,\"control_send_buffer_bytes\":" + size + "}");
      require(!socket.allowInventoryReplacement() && socket.controlSendBufferBytes() == size,
          "valid socket-only declaration lost its exact setting");
    }
    var replacement = config("{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":null}");
    require(replacement.allowInventoryReplacement() && replacement.controlSendBufferBytes() == null,
        "inventory-only declaration changed");
    var both = config("{\"version\":1,\"allow_inventory_replacement\":true,\"control_send_buffer_bytes\":4096}");
    require(both.allowInventoryReplacement() && both.controlSendBufferBytes() == 4096, "combined declaration rejected");
  }
  private static void disabledAndUnarmedDenial() {
    var owner = owner("owner", HASH, 1);
    var ref = new EffectAuthority.VisibleScreenRef("screen", 7, 8);
    Object screen = new Object(), handler = new Object();
    for (NativeEvaluationConfig config : new NativeEvaluationConfig[] {null,
        config("{\"version\":1,\"allow_inventory_replacement\":false,\"control_send_buffer_bytes\":4096}")}) {
      var off = new NativeEvaluationGate(config);
      require(!off.arm(owner, 5, screen, handler, ref), "disabled inventory facility armed");
      require(!off.consume(owner, 5, screen, handler, ref, 1), "disabled facility emitted effect");
      require(!off.armed() && !off.consumed(), "disabled facility recorded a trigger");
    }
    require(!gate().consume(owner, 5, screen, handler, ref, 1), "unarmed gate triggered");
  }
  private static void exactPinnedIdentityAndSingleConsumption() {
    var gate = gate();
    var owner = owner("owner", HASH, 1);
    var ref = new EffectAuthority.VisibleScreenRef("screen", 7, 8);
    Object screen = new Object(), handler = new Object();
    require(gate.arm(owner, 5, screen, handler, ref) && gate.armed(), "matching arm rejected");
    require(!gate.arm(owner("successor", HASH, 1), 6, new Object(), new Object(), ref), "second arm replaced original pins");
    require(!gate.consume(owner("other", HASH, 1), 5, screen, handler, ref, 1), "wrong operation owner triggered");
    require(!gate.consume(owner("owner", "b".repeat(64), 1), 5, screen, handler, ref, 1), "wrong source triggered");
    require(!gate.consume(owner("owner", HASH, 2), 5, screen, handler, ref, 1), "wrong cancellation generation triggered");
    require(!gate.consume(owner, 6, screen, handler, ref, 1), "wrong controller generation triggered");
    require(!gate.consume(owner, 5, new Object(), handler, ref, 1), "replacement screen object triggered");
    require(!gate.consume(owner, 5, screen, new Object(), ref, 1), "replacement handler triggered");
    require(!gate.consume(owner, 5, screen, handler, new EffectAuthority.VisibleScreenRef("other", 7, 8), 1), "wrong screen id triggered");
    require(!gate.consume(owner, 5, screen, handler, new EffectAuthority.VisibleScreenRef("screen", 9, 8), 1), "reused screen object/new incarnation triggered");
    require(!gate.consume(owner, 5, screen, handler, new EffectAuthority.VisibleScreenRef("screen", 7, 9), 1), "reused screen object/new layout triggered");
    for (int index : new int[] {-1, 0, 2, Integer.MAX_VALUE})
      require(!gate.consume(owner, 5, screen, handler, ref, index), "wrong operation index triggered: " + index);
    require(gate.armed() && !gate.consumed(), "mismatched probe consumed original arm");
    require(gate.consume(owner("owner", HASH, 1), 5, screen, handler,
        new EffectAuthority.VisibleScreenRef("screen", 7, 8), 1), "exact second operation failed to consume");
    require(gate.consumed() && !gate.armed(), "consumption not committed before caller performs replacement");
    require(!gate.consume(owner, 5, screen, handler, ref, 1), "effect retried after consumption");
    require(!gate.arm(owner, 5, screen, handler, ref), "consumed boot rearmed after failed caller effect");
  }
  private static void cancellationNeverTransfers() {
    var gate = gate();
    var original = owner("owner", HASH, 1);
    var successor = owner("successor", HASH, 2);
    Object screen = new Object(), handler = new Object();
    var ref = new EffectAuthority.VisibleScreenRef("screen", 7, 8);
    require(gate.arm(original, 5, screen, handler, ref), "cancellation positive control arm rejected");
    gate.cancel(successor);
    require(gate.armed(), "unrelated retirement cancelled original owner");
    gate.cancel(original);
    require(!gate.armed() && !gate.consumed(), "cancelled arm remained active or fabricated consumption");
    require(!gate.consume(original, 5, screen, handler, ref, 1), "retired owner triggered");
    require(!gate.consume(successor, 6, screen, handler, ref, 1), "cancelled arm transferred to successor");
    require(!gate.arm(successor, 6, screen, handler, ref), "cancelled boot rearmed for successor");
  }
  private static void invalidArmDoesNotSpendBoot() {
    var gate = gate();
    var owner = owner("owner", HASH, 1);
    Object screen = new Object(), handler = new Object();
    var ref = new EffectAuthority.VisibleScreenRef("screen", 7, 8);
    require(!gate.arm(null, 5, screen, handler, ref), "null owner armed");
    require(!gate.arm(owner, -1, screen, handler, ref), "invalid generation armed");
    require(!gate.arm(owner, 0, screen, handler, ref), "zero controller generation armed");
    require(!gate.arm(owner, ContractIdentity.MAX_SAFE + 1, screen, handler, ref), "unsafe controller generation armed");
    require(!gate.arm(owner, 5, null, handler, ref), "null screen armed");
    require(!gate.arm(owner, 5, screen, null, ref), "null handler armed");
    require(!gate.arm(owner, 5, screen, handler, null), "null visible reference armed");
    require(gate.arm(owner, 5, screen, handler, ref), "invalid arm spent the single valid arm");
  }
}
