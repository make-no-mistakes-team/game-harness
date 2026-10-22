package io.gameharness.nativeclient;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** The public profile's exact sound allowlist and 135 presence groups, never raw events. */
public final class SoundProjection {
  public record Group(int category, int direction, int distance) {}

  private final long[] delivered = new long[5 * 9 * 3];

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
      default -> -1;
    };
  }

  public void accept(String id, double dx, double dy, double dz, long at) {
    accept(category(id), dx, dy, dz, at);
  }

  public synchronized void accept(int category, double dx, double dy, double dz, long at) {
    if (category < 0
        || category >= 5
        || !Double.isFinite(dx)
        || !Double.isFinite(dy)
        || !Double.isFinite(dz)) return;
    double squared = dx * dx + dy * dy + dz * dz;
    if (squared > 1024) return;
    int band = squared < 64 ? 0 : squared < 256 ? 1 : 2;
    int direction = 0;
    if (dx * dx + dz * dz >= 1) {
      int sector = (int) Math.floor(Math.atan2(dx, -dz) / (Math.PI / 4) + .5);
      direction = 1 + Math.floorMod(sector, 8);
    }
    int group = (category * 9 + direction) * 3 + band;
    delivered[group] = Math.max(delivered[group], at);
  }

  public synchronized List<Group> drain(long capturedAt) {
    List<Group> result = new ArrayList<>(8);
    for (int i = 0; i < delivered.length; i++) {
      long at = delivered[i];
      delivered[i] = 0;
      if (at == 0 || at > capturedAt || capturedAt - at > 1000 || result.size() == 8) continue;
      result.add(new Group(i / 27, (i % 27) / 3, i % 3));
    }
    return result;
  }

  public synchronized void clear() {
    Arrays.fill(delivered, 0);
  }
}
