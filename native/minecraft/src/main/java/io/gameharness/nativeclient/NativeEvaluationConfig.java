package io.gameharness.nativeclient;

import com.google.gson.JsonElement;
import java.util.Set;

/** Exact default-off private launcher declaration, never an actor capability. */
public record NativeEvaluationConfig(boolean allowInventoryReplacement, Integer controlSendBufferBytes) {
  public NativeEvaluationConfig {
    if (controlSendBufferBytes != null && (controlSendBufferBytes < 4096 || controlSendBufferBytes > 16384)
        || !allowInventoryReplacement && controlSendBufferBytes == null)
      throw new IllegalArgumentException("Invalid native evaluation facilities");
  }

  public static NativeEvaluationConfig read(JsonElement input) {
    if (input == null) throw new IllegalArgumentException("Required native evaluation declaration missing");
    if (input.isJsonNull()) return null;
    if (!input.isJsonObject()) throw new IllegalArgumentException("Invalid native evaluation declaration");
    var value = input.getAsJsonObject();
    if (!value.keySet().equals(Set.of("version", "allow_inventory_replacement", "control_send_buffer_bytes"))
        || integer(value.get("version")) != 1)
      throw new IllegalArgumentException("Invalid native evaluation fields/version");
    JsonElement allow = value.get("allow_inventory_replacement"), buffer = value.get("control_send_buffer_bytes");
    if (!allow.isJsonPrimitive() || !allow.getAsJsonPrimitive().isBoolean())
      throw new IllegalArgumentException("Invalid native evaluation inventory flag");
    return new NativeEvaluationConfig(allow.getAsBoolean(), buffer.isJsonNull() ? null : integer(buffer));
  }

  private static int integer(JsonElement value) {
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException("Native evaluation integer required");
    try { return value.getAsBigDecimal().intValueExact(); }
    catch (ArithmeticException | NumberFormatException error) {
      throw new IllegalArgumentException("Invalid native evaluation integer");
    }
  }
}
