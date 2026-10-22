package io.gameharness.nativeclient;

import com.google.gson.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Receives launch credentials over the supervisor's private stdin, never argv or disk. */
public final class Bootstrap {
  public static void main(String[] ignored) throws Exception {
    byte[] input = System.in.readNBytes(131073);
    if (input.length > 131072) throw new IOException("Launch input exceeded bound");
    JsonObject config =
        JsonParser.parseString(new String(input, StandardCharsets.UTF_8)).getAsJsonObject();
    Arrays.fill(input, (byte) 0);
    System.setProperty("gameharness.session", config.get("session_file").getAsString());
    List<String> args = new ArrayList<>();
    for (JsonElement arg : config.getAsJsonArray("args")) args.add(arg.getAsString());
    try {
      Class.forName("net.fabricmc.loader.impl.launch.knot.KnotClient")
          .getMethod("main", String[].class)
          .invoke(null, (Object) args.toArray(String[]::new));
    } catch (java.lang.reflect.InvocationTargetException error) {
      // Third-party exceptions may contain auth arguments. Only a safe category crosses stdout.
      Throwable cause = error.getCause();
      while (cause != null) {
        System.err.println("GameHarness launch category: " + cause.getClass().getName());
        String message = String.valueOf(cause.getMessage());
        for (int i = 0; i + 1 < args.size(); i++)
          if (List.of("--username", "--uuid", "--accessToken").contains(args.get(i)))
            message = message.replace(args.get(i + 1), "<private>");
        message =
            message.replaceAll("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+", "<private>");
        System.err.println(
            "GHCAUSE "
                + message
                    .replace('\n', ' ')
                    .replace('\r', ' ')
                    .substring(0, Math.min(300, message.length())));
        for (int i = 0; i < Math.min(3, cause.getStackTrace().length); i++) {
          StackTraceElement frame = cause.getStackTrace()[i];
          System.err.println(
              "GHFRAME "
                  + frame.getClassName()
                  + "."
                  + frame.getMethodName()
                  + ":"
                  + frame.getLineNumber());
        }
        cause = cause.getCause();
      }
      System.exit(1);
    }
  }
}
