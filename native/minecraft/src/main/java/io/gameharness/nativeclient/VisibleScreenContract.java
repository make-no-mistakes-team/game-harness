package io.gameharness.nativeclient;

import com.google.gson.*;
import java.util.*;

/** Strict finite GUI input codec and local (never whole-inventory) value preconditions. */
public final class VisibleScreenContract {
  private static final Set<String> PRODUCTION_FIELDS = Set.of("producer", "item", "count", "source", "production_confirmed");
  private static final Set<String> PRODUCERS = Set.of("crafting", "smelting", "trading", "anvil");
  public record Value(String item, int count) {
    public Value {
      if (count < 0 || count > 4096 || (item == null) != (count == 0)
          || item != null && !item.matches("[a-z0-9_./-]+")) throw new IllegalArgumentException("Invalid visible slot value");
    }
    public JsonObject json() { JsonObject out = new JsonObject(); out.add("item", item == null ? JsonNull.INSTANCE : new JsonPrimitive(item)); out.addProperty("count", count); return out; }
  }
  public record Operation(String kind, int slot, int button, String mode, Integer hotbar,
      Value cursor, Map<Integer, Value> expected, String element, String text, String key, String phase,
      double horizontal, double vertical) {}
  /** An actual draw region, not a synthetic ClickableWidget. Binding stays private to native custody. */
  public record Region(String key, String binding, String kind, String text, boolean enabled,
      int x, int y, int width, int height) {
    public Region {
      if (key == null || key.isEmpty() || binding == null || !("choice".equals(kind) || "scroll_region".equals(kind))
          || text == null || text.length() > 256 || width <= 0 || height <= 0)
        throw new IllegalArgumentException("Invalid rendered GUI region");
    }
    public boolean contains(double px, double py) { return px >= x && py >= y && px < (double)x + width && py < (double)y + height; }
    public boolean accepts(String operation) { return enabled && (operation.equals("scroll") ? kind.equals("scroll_region") : operation.equals("element") && kind.equals("choice")); }
  }
  public record RenderedElement(String id, Region region) {}
  /** Exact reusable layout comparison; contents, cursor and progress deliberately do not participate. */
  public static final class RenderedLayout {
    private Object owner;
    private int width, height, count, index;
    private double scale;
    private boolean changed;
    private final Object[] targets = new Object[192];
    private final int[] ids = new int[192], xs = new int[192], ys = new int[192],
        widths = new int[192], heights = new int[192];
    private final boolean[] enabled = new boolean[192];
    public void begin(Object currentOwner, int currentWidth, int currentHeight, double currentScale) {
      changed |= owner != currentOwner || width != currentWidth || height != currentHeight
          || Double.compare(scale, currentScale) != 0;
      owner = currentOwner; width = currentWidth; height = currentHeight; scale = currentScale; index = 0;
    }
    public void slot(Object slot, int id, int x, int y, boolean active) { entry(slot, id, x, y, 16, 16, active, true); }
    public void element(String id, boolean active, int x, int y, int width, int height) { entry(id, -1, x, y, width, height, active, false); }
    private void entry(Object target, int id, int x, int y, int width, int height, boolean active, boolean identity) {
      if (index == targets.length || width <= 0 || height <= 0) throw new IllegalArgumentException("Invalid rendered layout bounds");
      int i = index++;
      changed |= i >= count || (identity ? targets[i] != target : !Objects.equals(targets[i], target))
          || ids[i] != id || xs[i] != x || ys[i] != y || widths[i] != width || heights[i] != height || enabled[i] != active;
      targets[i] = target; ids[i] = id; xs[i] = x; ys[i] = y; widths[i] = width; heights[i] = height; enabled[i] = active;
    }
    public boolean finish() {
      changed |= count != index;
      Arrays.fill(targets, index, Math.max(index, count), null);
      count = index; boolean result = changed; changed = false; return result;
    }
  }
  /** Current-frame bindings only. Disappearance, owner, page, meaning or geometry changes retire old ids. */
  public static final class RenderedRegions {
    private Object owner;
    private long sequence;
    private Map<String, RenderedElement> byKey = Map.of(), byId = Map.of();
    private List<RenderedElement> elements = List.of();
    public void publish(Object currentOwner, List<Region> current) {
      if (current.size() > 64) throw new IllegalArgumentException("Rendered region bound exceeded");
      Map<String, RenderedElement> keys = new LinkedHashMap<>(), ids = new HashMap<>();
      for (Region region : current) {
        if (keys.containsKey(region.key())) throw new IllegalArgumentException("Duplicate rendered GUI region");
        RenderedElement prior = owner == currentOwner ? byKey.get(region.key()) : null;
        Region old = prior == null ? null : prior.region();
        boolean same = old != null && old.binding().equals(region.binding()) && old.kind().equals(region.kind())
            && old.x() == region.x() && old.y() == region.y() && old.width() == region.width() && old.height() == region.height();
        String id = same ? prior.id() : "region-" + (sequence = ContractIdentity.next(sequence));
        var element = new RenderedElement(id, region); keys.put(region.key(), element); ids.put(id, element);
      }
      owner = currentOwner; byKey = keys; byId = ids; elements = List.copyOf(keys.values());
    }
    public RenderedElement find(String id) { return byId.get(id); }
    public List<RenderedElement> elements() { return elements; }
  }
  private static void fields(JsonObject object, String... names) {
    if (!object.keySet().equals(Set.of(names))) throw new IllegalArgumentException("Unknown or missing GUI operation fields");
  }
  public static int integer(JsonObject object, String key, int maximum) {
    long value = NativeEffectContract.counter(object, key);
    if (value > maximum) throw new IllegalArgumentException("GUI integer out of bounds"); return (int) value;
  }
  private static String string(JsonObject object, String key) {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw new IllegalArgumentException("GUI string required");
    return value.getAsString();
  }
  private static String choice(JsonObject object, String key, String... options) {
    String value = string(object, key); if (!Set.of(options).contains(value)) throw new IllegalArgumentException("Unsupported GUI " + key); return value;
  }
  private static double wheel(JsonObject object, String key) {
    JsonElement value = object.get(key);
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber())
      throw new IllegalArgumentException("GUI wheel number required");
    double number = value.getAsDouble();
    if (!Double.isFinite(number) || number < -16 || number > 16) throw new IllegalArgumentException("GUI wheel out of bounds");
    return number;
  }
  public static Value value(JsonObject object) {
    fields(object, "item", "count");
    return new Value(object.get("item").isJsonNull() ? null : string(object, "item"), integer(object, "count", 4096));
  }
  /** Validate actual result-take payloads under the same event bound as their server ledger. */
  public static void validateProductions(JsonArray productions) {
    if (productions.size() > GuiProductionLedger.LIMIT) throw new IllegalArgumentException("Receipt production overflow");
    for (JsonElement element : productions) {
      JsonObject row = element.getAsJsonObject();
      if (!row.keySet().equals(PRODUCTION_FIELDS)
          || !PRODUCERS.contains(NativeEffectContract.id(row, "producer"))
          || !NativeEffectContract.id(row, "item").matches("[a-z0-9_./-]+")
          || integer(row, "count", 4096) < 1
          || !NativeEffectContract.id(row, "source").equals("server_result_slot_take")
          || !row.get("production_confirmed").isJsonPrimitive() || !row.get("production_confirmed").getAsJsonPrimitive().isBoolean())
        throw new IllegalArgumentException("Invalid production receipt");
    }
  }
  public static Operation decode(JsonObject object) {
    String kind = choice(object, "kind", "slot", "element", "text", "key", "close", "scroll");
    if (kind.equals("slot")) {
      fields(object, "kind", "slot_id", "button", "mode", "hotbar_slot", "expected_cursor", "expected_slots");
      int slot = integer(object, "slot_id", 127);
      String mode = choice(object, "mode", "ordinary", "shift", "hotbar");
      Integer hotbar = object.get("hotbar_slot").isJsonNull() ? null : integer(object, "hotbar_slot", 8);
      if (mode.equals("hotbar") != (hotbar != null)) throw new IllegalArgumentException("Hotbar mode requires exactly one hotbar index");
      JsonArray fragments = object.getAsJsonArray("expected_slots");
      if (fragments.isEmpty() || fragments.size() > 16) throw new IllegalArgumentException("GUI source predicates required");
      Map<Integer, Value> expected = new LinkedHashMap<>();
      for (JsonElement fragment : fragments) {
        JsonObject entry = fragment.getAsJsonObject(); fields(entry, "slot_id", "value");
        if (expected.put(integer(entry, "slot_id", 127), value(entry.getAsJsonObject("value"))) != null) throw new IllegalArgumentException("Duplicate GUI source predicate");
      }
      if (!expected.containsKey(slot)) throw new IllegalArgumentException("Clicked GUI source predicate missing");
      return new Operation(kind, slot, choice(object, "button", "left", "right").equals("left") ? 0 : 1, mode, hotbar,
          value(object.getAsJsonObject("expected_cursor")), Map.copyOf(expected), null, null, null, null, 0, 0);
    }
    if (kind.equals("element")) {
      fields(object, "kind", "element_id", "button");
      return new Operation(kind, -1, choice(object, "button", "left", "right").equals("left") ? 0 : 1, null, null, null, Map.of(), NativeEffectContract.id(object, "element_id"), null, null, null, 0, 0);
    }
    if (kind.equals("scroll")) {
      fields(object, "kind", "element_id", "horizontal", "vertical");
      return new Operation(kind, -1, 0, null, null, null, Map.of(), NativeEffectContract.id(object, "element_id"), null, null, null, wheel(object, "horizontal"), wheel(object, "vertical"));
    }
    if (kind.equals("text")) {
      fields(object, "kind", "element_id", "text"); String text = string(object, "text");
      if (text.length() > 256 || text.chars().anyMatch(c -> c < 32 || c == 127 || Character.isSurrogate((char)c))) throw new IllegalArgumentException("Unsupported text characters");
      return new Operation(kind, -1, 0, null, null, null, Map.of(), NativeEffectContract.id(object, "element_id"), text, null, null, 0, 0);
    }
    if (kind.equals("key")) {
      fields(object, "kind", "key", "phase");
      String key = choice(object, "key", "escape", "enter", "backspace", "delete", "left", "right", "home", "end", "shift", "control", "1", "2", "3", "4", "5", "6", "7", "8", "9");
      return new Operation(kind, -1, 0, null, null, null, Map.of(), null, null, key, choice(object, "phase", "press", "release"), 0, 0);
    }
    fields(object, "kind"); return new Operation(kind, -1, 0, null, null, null, Map.of(), null, null, null, null, 0, 0);
  }
  public static List<Operation> operations(JsonObject action) {
    fields(action, "kind", "screen", "operations");
    if (!string(action, "kind").equals("screen_input")) throw new IllegalArgumentException("Expected screen input");
    JsonArray inputs = action.getAsJsonArray("operations");
    if (inputs.size() > 16) throw new IllegalArgumentException("GUI operation bound exceeded");
    List<Operation> operations = new ArrayList<>(inputs.size());
    for (JsonElement input : inputs) operations.add(decode(input.getAsJsonObject())); return List.copyOf(operations);
  }
  public static boolean matches(Operation operation, Value cursor, Map<Integer, Value> slots) {
    if (!operation.kind().equals("slot")) return true;
    if (!operation.cursor().equals(cursor)) return false;
    for (var predicate : operation.expected().entrySet()) if (!predicate.getValue().equals(slots.get(predicate.getKey()))) return false;
    return true;
  }
  /** GLFW's four modifier keys only; this route never samples or permits physical key state. */
  public static boolean ownedModifierPoll(boolean authorizedCall, long window, long ownedWindow, int key,
      boolean shift, boolean control) {
    if (!authorizedCall || window != ownedWindow) return false;
    return switch (key) {
      case 340, 344 -> shift;
      case 341, 345 -> control;
      default -> false;
    };
  }
  public static long total(Map<Integer, Value> slots, Value cursor) {
    long count = cursor.count(); for (Value value : slots.values()) count += value.count(); return count;
  }
  private VisibleScreenContract() {}
}
