package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.Set;

/** Decoded once at admission. No JSON decoding or event-list copying on simulation ticks. */
public final class WorldInputPlan {
  private static final String[] KEYS = {"forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use", "inventory"};
  private static final Set<String> ACTION = Set.of("kind", "steps");
  private static final Set<String> STEP = Set.of("ticks", "held", "edges", "view", "selected_hotbar");
  private static final Set<String> STREAM = Set.of("kind", "held", "edges", "view", "selected_hotbar");
  private static final Set<String> HELD = Set.of("forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use");
  private static final Set<String> BUTTON = Set.of("kind", "button", "phase", "count");
  private static final Set<String> HOTBAR = Set.of("kind", "slot");
  private static final Set<String> DROP = Set.of("kind", "all");
  private static final Set<String> KIND = Set.of("kind");
  private static final Set<String> DELTA = Set.of("kind", "yaw_radians", "pitch_radians");
  private static final Set<String> RATE = Set.of("kind", "yaw_radians_per_second", "pitch_radians_per_second");
  public enum EdgeKind { BUTTON, HOTBAR, SWAP, DROP }
  public record Edge(EdgeKind kind, int key, boolean press, int count, int slot, boolean all) {}
  public static final class Step {
    private final int ticks, held, selected, expanded;
    private final Edge[] edges;
    private final boolean rate, dropAll;
    private final double yaw, pitch;
    private Step(int ticks, int held, int selected, Edge[] edges,
        boolean rate, boolean dropAll, double yaw, double pitch, int expanded) {
      this.ticks = ticks; this.held = held; this.selected = selected; this.edges = edges;
      this.rate = rate; this.dropAll = dropAll; this.yaw = yaw; this.pitch = pitch;
      this.expanded = expanded;
    }
    public int ticks() { return ticks; }
    public boolean held(int key) { return key >= 0 && key < 9 && (held & (1 << key)) != 0; }
    public int heldMask() { return held; }
    public int expandedEdges() { return expanded; }
    public int selected() { return selected; }
    public int edgeCount() { return edges.length; }
    public Edge edge(int index) { return edges[index]; }
    public boolean dropAll() { return dropAll; }
    public double yawDelta(boolean entry) { return rate ? yaw * .05 : entry ? yaw : 0; }
    public double pitchDelta(boolean entry) { return rate ? pitch * .05 : entry ? pitch : 0; }
  }
  private final Step[] steps;
  private final int totalTicks;
  private WorldInputPlan(Step[] steps, int totalTicks) { this.steps = steps; this.totalTicks = totalTicks; }
  public Step step(int index) { return steps[index]; }
  public int stepCount() { return steps.length; }
  public int totalTicks() { return totalTicks; }

  private static void fields(JsonObject object, Set<String> expected) {
    if (object == null || !object.keySet().equals(expected)) throw new IllegalArgumentException("Unknown or missing world input fields");
  }
  private static int integer(JsonObject object, String key, int min, int max) {
    long value = NativeEffectContract.counter(object, key);
    if (value < min || value > max) throw new IllegalArgumentException("World input integer out of range: " + key);
    return (int) value;
  }
  private static boolean bool(JsonObject object, String key) {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean())
      throw new IllegalArgumentException("World input boolean required: " + key);
    return value.getAsBoolean();
  }
  private static double finite(JsonObject object, String key, double limit) {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException("World input number required: " + key);
    double number = value.getAsDouble();
    if (!Double.isFinite(number) || Math.abs(number) > limit) throw new IllegalArgumentException("World view out of range");
    return number;
  }
  public static WorldInputPlan decode(JsonObject action) {
    try {
      fields(action, ACTION);
      if (!NativeEffectContract.id(action, "kind").equals("world_input")) throw new IllegalArgumentException("Not world input");
      JsonArray source = action.getAsJsonArray("steps");
      if (source.size() < 1 || source.size() > 64) throw new IllegalArgumentException("World step limit");
      Step[] steps = new Step[source.size()]; int prior = 0, ticks = 0, expanded = 0;
      for (int s = 0; s < steps.length; s++) {
        Step step = decodeStep(source.get(s).getAsJsonObject(), prior, false);
        ticks += step.ticks(); expanded += step.expandedEdges();
        if (ticks > 100) throw new IllegalArgumentException("World tick limit");
        if (expanded > 256) throw new IllegalArgumentException("Expanded world edge limit");
        steps[s] = step; prior = step.heldMask();
      }
      return new WorldInputPlan(steps, ticks);
    } catch (IllegalStateException | NullPointerException | ClassCastException error) {
      throw new IllegalArgumentException("Malformed ordinary world input", error);
    }
  }

  public static Step streamStep(JsonObject value, int prior) {
    if (prior < 0 || prior > 511) throw new IllegalArgumentException("Invalid prior held state");
    return decodeStep(value, prior, true);
  }

  private static Step decodeStep(JsonObject value, int prior, boolean stream) {
    try {
        fields(value, stream ? STREAM : STEP);
        if (stream && !NativeEffectContract.id(value, "kind").equals("world"))
          throw new IllegalArgumentException("Not world stream input");
        int duration = stream ? 1 : integer(value, "ticks", 1, 100), expanded = 0;
        JsonObject held = value.getAsJsonObject("held"); fields(held, HELD); int mask = 0;
        for (int key = 0; key < 9; key++) if (bool(held, KEYS[key])) mask |= 1 << key;
        JsonArray events = value.getAsJsonArray("edges");
        if (events.size() > 256) throw new IllegalArgumentException("World edge limit");
        Edge[] edges = new Edge[events.size()];
        int transition = prior, hotbar = -1; Boolean dropAll = null;
        for (int e = 0; e < edges.length; e++) {
          JsonObject event = events.get(e).getAsJsonObject(); String kind = NativeEffectContract.id(event, "kind");
          Edge edge;
          switch (kind) {
            case "button" -> {
              fields(event, BUTTON); String name = NativeEffectContract.id(event, "button"); int key = -1;
              for (int i = 0; i < KEYS.length; i++) if (KEYS[i].equals(name)) { key = i; break; }
              if (key < 0) throw new IllegalArgumentException("Unknown world button");
              String phase = NativeEffectContract.id(event, "phase");
              if (!phase.equals("press") && !phase.equals("release")) throw new IllegalArgumentException("Unknown world phase");
              boolean press = phase.equals("press"); int count = integer(event, "count", 1, press ? 256 : 1);
              if (key < 9) transition = press ? transition | (1 << key) : transition & ~(1 << key);
              edge = new Edge(EdgeKind.BUTTON, key, press, count, -1, false);
            }
            case "hotbar" -> {
              fields(event, HOTBAR);
              if (hotbar != -1) throw new IllegalArgumentException("Only one hotbar edge per step");
              hotbar = integer(event, "slot", 0, 8); edge = new Edge(EdgeKind.HOTBAR, -1, true, 1, hotbar, false);
            }
            case "hand_swap" -> { fields(event, KIND); edge = new Edge(EdgeKind.SWAP, -1, true, 1, -1, false); }
            case "drop" -> {
              fields(event, DROP); boolean all = bool(event, "all");
              if (dropAll != null && dropAll != all) throw new IllegalArgumentException("Conflicting drop modifiers");
              dropAll = all; edge = new Edge(EdgeKind.DROP, -1, true, 1, -1, all);
            }
            default -> throw new IllegalArgumentException("Not an ordinary world edge");
          }
          expanded += edge.count(); if (expanded > 256) throw new IllegalArgumentException("Expanded world edge limit");
          edges[e] = edge;
        }
        if (transition != mask) throw new IllegalArgumentException("Declared held state disagrees with transitions");
        int selected = value.get("selected_hotbar").isJsonNull() ? -1 : integer(value, "selected_hotbar", 0, 8);
        if (selected >= 0 && hotbar >= 0 && selected != hotbar) throw new IllegalArgumentException("Conflicting hotbar declaration");
        JsonObject view = value.getAsJsonObject("view"); String kind = NativeEffectContract.id(view, "kind");
        double yaw = 0, pitch = 0; boolean rate = false;
        switch (kind) {
          case "unchanged" -> fields(view, KIND);
          case "delta" -> { fields(view, DELTA); yaw = finite(view, "yaw_radians", 2 * Math.PI); pitch = finite(view, "pitch_radians", 2 * Math.PI); }
          case "rate" -> { fields(view, RATE); rate = true; yaw = finite(view, "yaw_radians_per_second", 20 * Math.PI); pitch = finite(view, "pitch_radians_per_second", 20 * Math.PI); }
          default -> throw new IllegalArgumentException("Unknown world view");
        }
        return new Step(duration, mask, selected, edges, rate, Boolean.TRUE.equals(dropAll), yaw, pitch, expanded);
    } catch (IllegalStateException | NullPointerException | ClassCastException error) {
      throw new IllegalArgumentException("Malformed ordinary world input", error);
    }
  }
}
