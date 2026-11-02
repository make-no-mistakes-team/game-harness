package io.gameharness.nativeclient;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/** Actual-heard, coarse-only events; every reader owns its own stream cursor. */
public final class SoundProjection {
  public record Cursor(String streamId, long sequence) {}

  public record Event(
      long sequence,
      int category,
      String cue,
      int direction,
      int distance,
      long wallMillis,
      long nativeNanos) {}

  public record Page(
      String streamId,
      long afterSequence,
      Cursor nextCursor,
      boolean gap,
      long omittedBefore,
      boolean hasMore,
      List<Event> events) {}

  public record Group(int category, int direction, int distance, long wallMillis) {}

  private static final int CAPACITY = 128;
  private static final int PAGE_SIZE = 8;
  private static final long TTL_NANOS = 1_000_000_000L;
  private static final long MAX_SEQUENCE = 9_007_199_254_740_991L;
  private final Event[] retained = new Event[CAPACITY];
  private final Event[] grouped = new Event[5 * 9 * 3];
  private String streamId = UUID.randomUUID().toString();
  private long sequence;
  private int head;
  private int size;

  /** Kinds 0..4 retain the old categories; kind 5 is the sole additional priming cue. */
  public static int category(String id) {
    return switch (id) {
      case "minecraft:block.grass.step", "minecraft:entity.player.swim" -> 0;
      case "minecraft:block.stone.break",
              "minecraft:block.stone.place",
              "minecraft:block.wood.break",
              "minecraft:block.wood.place" ->
          1;
      case "minecraft:entity.player.hurt",
              "minecraft:entity.generic.hurt",
              "minecraft:entity.generic.death",
              "minecraft:entity.arrow.shoot",
              "minecraft:entity.generic.explode" ->
          2;
      case "minecraft:entity.zombie.ambient", "minecraft:entity.skeleton.ambient" -> 3;
      case "minecraft:entity.lightning_bolt.thunder" -> 4;
      case "minecraft:entity.creeper.primed" -> 5;
      default -> -1;
    };
  }

  /** The production Source.play boundary supplies actual playing, gain and listener values. */
  public static boolean audible(
      boolean playing,
      double gain,
      double masterGain,
      boolean relative,
      boolean linear,
      double cutoff,
      double dx,
      double dy,
      double dz) {
    if (!playing
        || relative
        || !Double.isFinite(gain)
        || !(gain > 0)
        || !Double.isFinite(masterGain)
        || !(masterGain > 0)
        || !Double.isFinite(dx)
        || !Double.isFinite(dy)
        || !Double.isFinite(dz)) return false;
    double squared = dx * dx + dy * dy + dz * dz;
    return squared <= 1024
        && (!linear || (Double.isFinite(cutoff) && cutoff > 0 && squared < cutoff * cutoff));
  }

  public synchronized String streamId() {
    return streamId;
  }

  public void accept(String id, double dx, double dy, double dz, long wallMillis, long nativeNanos) {
    accept(category(id), dx, dy, dz, wallMillis, nativeNanos);
  }

  /** Reject a delayed Source.play callback tagged in a previous scope. */
  public synchronized void accept(
      String expectedStreamId,
      int kind,
      double dx,
      double dy,
      double dz,
      long wallMillis,
      long nativeNanos) {
    if (streamId.equals(expectedStreamId)) append(kind, dx, dy, dz, wallMillis, nativeNanos);
  }

  public synchronized void accept(
      int kind, double dx, double dy, double dz, long wallMillis, long nativeNanos) {
    append(kind, dx, dy, dz, wallMillis, nativeNanos);
  }

  private void append(
      int kind, double dx, double dy, double dz, long wallMillis, long nativeNanos) {
    if (kind < 0
        || kind > 5
        || !Double.isFinite(dx)
        || !Double.isFinite(dy)
        || !Double.isFinite(dz)) return;
    double squared = dx * dx + dy * dy + dz * dz;
    if (squared > 1024) return;
    int distance = squared < 64 ? 0 : squared < 256 ? 1 : 2;
    int direction = 0;
    if (dx * dx + dz * dz >= 1) {
      int sector = (int) Math.floor(Math.atan2(dx, -dz) / (Math.PI / 4) + .5);
      direction = 1 + Math.floorMod(sector, 8);
    }
    if (sequence == MAX_SEQUENCE) throw new IllegalStateException("sound sequence exhausted");
    Event event = new Event(++sequence, kind == 5 ? 2 : kind,
        kind == 5 ? "creeper_primed" : null, direction, distance, wallMillis, nativeNanos);
    if (size == CAPACITY) {
      retained[head] = event;
      head = (head + 1) % CAPACITY;
    } else {
      retained[(head + size) % CAPACITY] = event;
      size++;
    }
  }

  /** Null starts at zero in this stream; omissions are acknowledged only by the returned cursor. */
  public synchronized Page page(Cursor cursor, long nowNativeNanos) {
    long after = 0;
    if (cursor != null) {
      if (!streamId.equals(cursor.streamId()) || cursor.sequence() < 0
          || cursor.sequence() > sequence) throw new IllegalArgumentException("invalid sound cursor");
      after = cursor.sequence();
    }
    expire(nowNativeNanos);
    int start = 0;
    while (start < size && at(start).sequence() <= after) start++;
    if (start == size) {
      long omitted = sequence - after;
      return new Page(streamId, after, new Cursor(streamId, sequence), omitted > 0,
          omitted, false, List.of());
    }
    long omitted = at(start).sequence() - after - 1;
    List<Event> events = new ArrayList<>(Math.min(PAGE_SIZE, size - start));
    int end = start;
    long next = at(start).sequence() - 1;
    while (end < size && events.size() < PAGE_SIZE) {
      Event event = at(end);
      // A rare reordered callback can expire between retained events. Report that gap on
      // the next page, rather than silently crossing it inside this page.
      if (event.sequence() != next + 1) break;
      events.add(event);
      next = event.sequence();
      end++;
    }
    return new Page(streamId, after, new Cursor(streamId, next), omitted > 0,
        omitted, end < size, Collections.unmodifiableList(events));
  }

  /** Bounded legacy presence, using original event wall time and never consuming the ring. */
  public synchronized List<Group> recent(long nowNativeNanos) {
    expire(nowNativeNanos);
    Arrays.fill(grouped, null);
    for (int i = 0; i < size; i++) {
      Event event = at(i);
      grouped[(event.category() * 9 + event.direction()) * 3 + event.distance()] = event;
    }
    List<Group> result = null;
    for (Event event : grouped) {
      if (event == null) continue;
      if (result == null) result = new ArrayList<>(PAGE_SIZE);
      result.add(new Group(event.category(), event.direction(), event.distance(), event.wallMillis()));
      if (result.size() == PAGE_SIZE) break;
    }
    Arrays.fill(grouped, null);
    return result == null ? List.of() : Collections.unmodifiableList(result);
  }

  public synchronized void clear() {
    Arrays.fill(retained, null);
    Arrays.fill(grouped, null);
    head = 0;
    size = 0;
    sequence = 0;
    streamId = UUID.randomUUID().toString();
  }

  private Event at(int offset) {
    return retained[(head + offset) % CAPACITY];
  }

  private void expire(long nowNativeNanos) {
    int kept = 0;
    for (int i = 0; i < size; i++) {
      Event event = at(i);
      // Subtraction works across nanoTime wrap; its absolute origin may be negative.
      long age = nowNativeNanos - event.nativeNanos();
      if (age <= TTL_NANOS) retained[(head + kept++) % CAPACITY] = event;
    }
    for (int i = kept; i < size; i++) retained[(head + i) % CAPACITY] = null;
    size = kept;
  }
}
