package io.gameharness.nativeclient;

import com.google.gson.*;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collections;

/** Loaded from the actual JAR once. Launch configuration cannot supply or replace these identities. */
public final class NativeContractResource {
  private static final JsonObject RESOURCE = read();
  private static final JsonObject DESCRIPTOR = RESOURCE.getAsJsonObject("descriptor");
  private static final JsonObject CONFIGURATION = DESCRIPTOR.getAsJsonObject("observation").getAsJsonObject("profile").getAsJsonObject("configuration");
  public static final int RADIUS = counter(CONFIGURATION.getAsJsonObject("sampler"), "radius_blocks", 8);
  public static final int MAX_BLOCKS = counter(CONFIGURATION.getAsJsonObject("sampler"), "max_blocks", 144);
  public static final int MAX_ENTITIES = counter(CONFIGURATION.getAsJsonObject("sampler"), "max_entities", 32);
  public static final int MAX_AGE_MS = counter(CONFIGURATION.getAsJsonObject("sampler"), "max_age_ms", 1000);
  public static final int RADIUS_SQUARED = RADIUS * RADIUS;

  private NativeContractResource() {}

  private static JsonObject read() {
    try (InputStream input = NativeContractResource.class.getResourceAsStream("/gameharness-native-contract.json")) {
      if (input == null) throw new IllegalStateException("Native build contract resource is absent; rebuild the native artifact");
      byte[] bytes = input.readNBytes(1048577);
      if (bytes.length > 1048576) throw new IllegalStateException("Native build contract resource exceeds bound");
      JsonObject resource = JsonParser.parseString(new String(bytes, StandardCharsets.UTF_8)).getAsJsonObject();
      if (resource.get("resource_schema").getAsInt() != 1) throw new IllegalStateException("Unknown native resource schema");
      JsonObject descriptor = resource.getAsJsonObject("descriptor");
      String actualInputs = hash(resource.get("build_inputs"));
      if (!actualInputs.equals(descriptor.getAsJsonObject("adapter").get("build_hash").getAsString()))
        throw new IllegalStateException("Native resource has inconsistent actual build inputs");
      JsonObject observation = descriptor.getAsJsonObject("observation");
      JsonObject schemas = resource.getAsJsonObject("schemas");
      if (!hash(schemas.get("observation")).equals(observation.get("schema_hash").getAsString())
          || !hash(schemas.get("payload")).equals(observation.getAsJsonObject("payload_schema").get("hash").getAsString()))
        throw new IllegalStateException("Native resource has inconsistent observation schemas");
      JsonObject profile = observation.getAsJsonObject("profile");
      if (!hash(profile.get("configuration")).equals(profile.get("configuration_hash").getAsString()))
        throw new IllegalStateException("Native resource has inconsistent effective configuration");
      for (JsonElement element : descriptor.getAsJsonArray("capabilities")) {
        JsonObject capability = element.getAsJsonObject();
        String key = capability.get("id").getAsString() + "@" + capability.get("version").getAsInt();
        JsonElement schema = schemas.getAsJsonObject("capabilities").get(key);
        if (schema == null || !hash(schema).equals(capability.get("schema_hash").getAsString()))
          throw new IllegalStateException("Native resource capability is not actually registered");
      }
      return resource;
    } catch (IOException | IllegalArgumentException error) {
      throw new IllegalStateException("Cannot read the actual compiled native contract", error);
    }
  }

  private static int counter(JsonObject object, String key, int supported) {
    long value = NativeEffectContract.counter(object, key);
    if (value != supported) throw new IllegalStateException("Unsupported compiled native sampler configuration");
    return Math.toIntExact(value); // bounded sampler counts, never an epoch/incarnation
  }

  /** One copy/hash at binding or a real profile change, never per observation/tick/frame. */
  public static JsonObject descriptor(String actualMotorProfile) {
    if (!actualMotorProfile.equals("precise") && !actualMotorProfile.equals("balanced") && !actualMotorProfile.equals("fast"))
      throw new IllegalArgumentException("Unsupported actual motor profile");
    JsonObject descriptor = DESCRIPTOR.deepCopy();
    JsonObject profile = descriptor.getAsJsonObject("observation").getAsJsonObject("profile");
    profile.getAsJsonObject("configuration").addProperty("motor_profile", actualMotorProfile);
    profile.addProperty("configuration_hash", hash(profile.get("configuration")));
    return descriptor;
  }

  public static String hash(JsonElement value) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(canonical(value).getBytes(StandardCharsets.UTF_8));
      return java.util.HexFormat.of().formatHex(digest);
    } catch (NoSuchAlgorithmException error) {
      throw new IllegalStateException("SHA-256 is required", error);
    }
  }

  private static String canonical(JsonElement value) {
    if (value == null || value.isJsonNull() || value.isJsonPrimitive()) return String.valueOf(value);
    StringBuilder result = new StringBuilder();
    if (value.isJsonArray()) {
      result.append('[');
      boolean first = true;
      for (JsonElement child : value.getAsJsonArray()) {
        if (!first) result.append(',');
        result.append(canonical(child)); first = false;
      }
      return result.append(']').toString();
    }
    JsonObject object = value.getAsJsonObject();
    ArrayList<String> keys = new ArrayList<>(object.keySet());
    Collections.sort(keys);
    result.append('{');
    for (int i = 0; i < keys.size(); i++) {
      if (i != 0) result.append(',');
      String key = keys.get(i);
      result.append(new JsonPrimitive(key)).append(':').append(canonical(object.get(key)));
    }
    return result.append('}').toString();
  }
}
