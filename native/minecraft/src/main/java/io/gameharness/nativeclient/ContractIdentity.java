package io.gameharness.nativeclient;

import java.math.BigDecimal;
import java.util.regex.Pattern;

/** Exact JSON-number identities shared with JavaScript; never narrow through int or double. */
public final class ContractIdentity {
  public static final long MAX_SAFE = 9007199254740991L;
  private static final Pattern JSON_NUMBER = Pattern.compile("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?");
  private static final Pattern SHA256 = Pattern.compile("[a-f0-9]{64}");

  private ContractIdentity() {}

  public static long counter(String jsonNumber) {
    if (jsonNumber == null || jsonNumber.length() > 64 || !JSON_NUMBER.matcher(jsonNumber).matches())
      throw new IllegalArgumentException("Identity must be a JSON number");
    final long value;
    try {
      value = new BigDecimal(jsonNumber).longValueExact();
    } catch (ArithmeticException error) {
      throw new IllegalArgumentException("Identity must be an exact safe integer", error);
    }
    return checked(value);
  }

  public static long checked(long value) {
    if (value < 0 || value > MAX_SAFE) throw new IllegalArgumentException("Identity exceeds JavaScript safe integer range");
    return value;
  }

  public static long next(long value) {
    checked(value);
    if (value == MAX_SAFE) throw new IllegalStateException("Identity counter exhausted");
    return value + 1;
  }

  public static String id(String value) {
    if (value == null || value.isEmpty() || value.length() > 160)
      throw new IllegalArgumentException("Identity must be nonempty and bounded");
    return value;
  }

  public static String hash(String value) {
    if (value == null || !SHA256.matcher(value).matches()) throw new IllegalArgumentException("Invalid SHA256 identity");
    return value;
  }
}
