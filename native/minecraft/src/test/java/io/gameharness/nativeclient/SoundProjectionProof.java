package io.gameharness.nativeclient;

/** Pure audible boundary and consumer-owned cursor regressions; no native fixture mutation. */
public final class SoundProjectionProof {
  private static final long NOW = -5_000_000_000L;
  private static final long WALL = 1_800_000_000_000L;

  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void rejects(Runnable read, String message) {
    try {
      read.run();
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError(message);
  }

  private static void independentReaders() {
    SoundProjection sounds = new SoundProjection();
    for (int i = 0; i < 19; i++) sounds.accept(0, 0, 0, -2, WALL + i, NOW + i);
    var first = sounds.page(null, NOW + 19);
    var other = sounds.page(null, NOW + 19);
    require(first.equals(other), "one reader consumed another reader's first page");
    require(first.afterSequence() == 0 && first.events().size() == 8
        && first.events().getFirst().sequence() == 1
        && first.nextCursor().sequence() == 8 && first.hasMore()
        && !first.gap() && first.omittedBefore() == 0, "first page is incomplete or falsely gapped");
    var second = sounds.page(first.nextCursor(), NOW + 19);
    require(second.events().size() == 8 && second.events().getFirst().sequence() == 9
        && second.nextCursor().sequence() == 16 && second.hasMore(), "page continuation lost events");
    require(second.equals(sounds.page(other.nextCursor(), NOW + 19)),
        "independent cursor continuation was consumed");
    var third = sounds.page(second.nextCursor(), NOW + 19);
    require(third.events().size() == 3 && third.events().getFirst().sequence() == 17
        && third.nextCursor().sequence() == 19 && !third.hasMore(), "last page lost or replayed events");
    var empty = sounds.page(third.nextCursor(), NOW + 19);
    require(empty.events().isEmpty() && empty.nextCursor().equals(third.nextCursor())
        && !empty.gap() && !empty.hasMore(), "caught-up cursor replayed history");
    try {
      first.events().clear();
      throw new AssertionError("caller could mutate a sound page");
    } catch (UnsupportedOperationException expected) {
      // Pages are immutable snapshots, not a view into the mutable ring.
    }
  }

  private static void overflowAndExpiry() {
    SoundProjection sounds = new SoundProjection();
    for (int i = 0; i < 140; i++) sounds.accept(1, 0, 0, -2, WALL + i, NOW + i);
    var first = sounds.page(null, NOW + 140);
    require(first.gap() && first.omittedBefore() == 12 && first.events().size() == 8
        && first.events().getFirst().sequence() == 13 && first.nextCursor().sequence() == 20
        && first.hasMore(), "capacity overflow was silent or page cap discarded the remainder");
    var cursor = first.nextCursor();
    int observed = first.events().size();
    while (true) {
      var page = sounds.page(cursor, NOW + 140);
      require(!page.gap() && page.omittedBefore() == 0, "retained continuation invented an omission");
      for (var event : page.events()) {
        require(event.sequence() == cursor.sequence() + 1, "continuation skipped or repeated an event");
        cursor = new SoundProjection.Cursor(page.streamId(), event.sequence());
        observed++;
      }
      cursor = page.nextCursor();
      if (!page.hasMore()) break;
    }
    require(observed == 128 && cursor.sequence() == 140, "ring did not retain exactly its capacity");
    var expired = sounds.page(first.nextCursor(), NOW + 1_000_000_140L);
    require(expired.events().isEmpty() && expired.gap() && expired.omittedBefore() == 120
        && expired.nextCursor().sequence() == 140 && !expired.hasMore(),
        "expiry did not honestly advance over omitted events");
    require(!sounds.page(expired.nextCursor(), NOW + 1_000_000_141L).gap(),
        "acknowledged expiry was reported twice");

    SoundProjection boundary = new SoundProjection();
    boundary.accept(0, 0, 0, 2, WALL, NOW);
    require(boundary.page(null, NOW + 1_000_000_000L).events().size() == 1,
        "one-second TTL boundary expired early");
    require(boundary.page(null, NOW + 1_000_000_001L).omittedBefore() == 1,
        "native monotonic expiry relied on wall-clock time");
    boundary.accept(0, 0, 0, 2, WALL - 10_000, NOW + 1_000_000_002L);
    var fresh = boundary.page(null, NOW + 1_000_000_003L);
    require(fresh.gap() && fresh.omittedBefore() == 1
        && fresh.events().getFirst().sequence() == 2
        && fresh.events().getFirst().wallMillis() == WALL - 10_000,
        "new event after expiry hid the gap or rewrote its original wall time");

    SoundProjection reordered = new SoundProjection();
    reordered.accept(0, 0, 0, 2, WALL, NOW + 2);
    reordered.accept(0, 0, 0, 2, WALL, NOW);
    reordered.accept(0, 0, 0, 2, WALL, NOW + 2);
    var beforeHole = reordered.page(null, NOW + 1_000_000_001L);
    require(beforeHole.events().size() == 1 && beforeHole.nextCursor().sequence() == 1
        && !beforeHole.gap() && beforeHole.hasMore(), "expired internal event was silently crossed");
    var afterHole = reordered.page(beforeHole.nextCursor(), NOW + 1_000_000_001L);
    require(afterHole.gap() && afterHole.omittedBefore() == 1
        && afterHole.events().getFirst().sequence() == 3 && !afterHole.hasMore(),
        "out-of-order callback expiry lost its explicit omission");

    SoundProjection trailingExpiry = new SoundProjection();
    trailingExpiry.accept(0, 0, 0, 2, WALL, NOW + 2);
    trailingExpiry.accept(0, 0, 0, 2, WALL, NOW);
    var live = trailingExpiry.page(null, NOW + 1_000_000_001L);
    require(live.events().size() == 1 && !live.hasMore(),
        "has_more claimed an available event when only an expired sequence remained");
    var tail = trailingExpiry.page(live.nextCursor(), NOW + 1_000_000_001L);
    require(tail.events().isEmpty() && tail.omittedBefore() == 1
        && tail.nextCursor().sequence() == 2, "expired tail was never acknowledged");
  }

  private static void scopeFences() {
    SoundProjection sounds = new SoundProjection();
    String oldStream = sounds.streamId();
    sounds.accept(oldStream, 5, 0, 0, 2, WALL, NOW);
    var old = sounds.page(null, NOW).nextCursor();
    require("creeper_primed".equals(sounds.recent(NOW).getFirst().cue()),
        "ordinary projection lost the old scope's admitted cue");
    rejects(() -> sounds.page(new SoundProjection.Cursor(oldStream, 2), NOW),
        "future cursor was admitted");
    rejects(() -> sounds.page(new SoundProjection.Cursor(oldStream, -1), NOW),
        "negative cursor was admitted");
    sounds.clear();
    require(!oldStream.equals(sounds.streamId()), "scope reset reused stream identity");
    rejects(() -> sounds.page(old, NOW), "old-life cursor crossed a scope reset");
    rejects(() -> sounds.page(new SoundProjection.Cursor("foreign", 0), NOW),
        "foreign stream acquired history");
    sounds.accept(oldStream, 5, 0, 0, 2, WALL, NOW);
    sounds.accept((String) null, 5, 0, 0, 2, WALL, NOW);
    var reset = sounds.page(null, NOW);
    require(reset.events().isEmpty() && reset.nextCursor().sequence() == 0 && !reset.gap()
        && sounds.recent(NOW).isEmpty(),
        "late old-scope callback or unadmitted tag entered the new ring");
    sounds.accept(sounds.streamId(), 5, 0, 0, 2, WALL + 1, NOW + 1);
    require(sounds.page(null, NOW + 1).events().getFirst().sequence() == 1
        && sounds.recent(NOW + 1).size() == 1
        && sounds.recent(NOW + 1).getFirst().wallMillis() == WALL + 1,
        "new scope did not start an independent sequence");
  }

  private static void binsAndLegacyPresence() {
    SoundProjection sounds = new SoundProjection();
    sounds.accept("minecraft:block.grass.step", .5, 7, 0, WALL, NOW);
    sounds.accept("minecraft:block.grass.step", .75, 7, 0, WALL + 7, NOW + 7);
    sounds.accept("minecraft:entity.zombie.ambient", 0, 0, -8, WALL + 1, NOW + 1);
    sounds.accept("minecraft:block.stone.break", 16, 0, 0, WALL + 2, NOW + 2);
    sounds.accept("minecraft:entity.lightning_bolt.thunder", 32, 0, 0, WALL + 3, NOW + 3);
    sounds.accept("minecraft:block.grass.step", 32.001, 0, 0, WALL, NOW);
    sounds.accept(0, Double.NaN, 0, 0, WALL, NOW);
    sounds.accept(0, Double.POSITIVE_INFINITY, 0, 0, WALL, NOW);
    sounds.accept(0, 1e308, 0, 0, WALL, NOW);
    var page = sounds.page(null, NOW + 7);
    require(page.events().size() == 5, "range or finite-value gate admitted a hidden source");
    require(page.events().get(0).direction() == 0 && page.events().get(0).distance() == 0,
        "horizontal here/near bins changed");
    require(page.events().get(2).direction() == 1 && page.events().get(2).distance() == 1,
        "exact eight-block boundary or north bin changed");
    require(page.events().get(3).direction() == 3 && page.events().get(3).distance() == 2
        && page.events().get(4).distance() == 2, "sixteen/32-block boundary changed");
    var groups = sounds.recent(NOW + 7);
    require(groups.size() == 4 && groups.getFirst().wallMillis() == WALL + 7,
        "legacy groups duplicated presence or replaced original event time");
    require(groups.equals(sounds.recent(NOW + 7)) && page.equals(sounds.page(null, NOW + 7)),
        "legacy observer consumed another observer's hearing");
    require(sounds.recent(NOW + 1_000_000_008L).isEmpty(), "legacy presence outlived monotonic TTL");
    SoundProjection compass = new SoundProjection();
    double[][] offsets = {{0, -2}, {2, -2}, {2, 0}, {2, 2}, {0, 2}, {-2, 2}, {-2, 0}, {-2, -2}};
    for (double[] offset : offsets) compass.accept(0, offset[0], 0, offset[1], WALL, NOW);
    var directions = compass.page(null, NOW).events();
    for (int i = 0; i < 8; i++) require(directions.get(i).direction() == i + 1,
        "compass bin is not world-relative N/NE/E/SE/S/SW/W/NW");
    SoundProjection manyGroups = new SoundProjection();
    for (int category = 0; category < 5; category++)
      for (double[] offset : offsets)
        manyGroups.accept(category, offset[0], 0, offset[1], WALL, NOW);
    require(manyGroups.recent(NOW).size() == 8
        && manyGroups.recent(NOW).size() == 8
        && manyGroups.page(null, NOW).events().size() == 8
        && manyGroups.page(null, NOW).hasMore(),
        "legacy group cap discarded ring events or consumed the next observer's presence");
  }

  private static void ordinaryCueGroups() {
    for (boolean cueFirst : new boolean[] {true, false}) {
      SoundProjection sounds = new SoundProjection();
      sounds.accept(cueFirst ? 5 : 2, 0, 0, 2, WALL, NOW);
      sounds.accept(cueFirst ? 2 : 5, 0, 0, 2, WALL + 7, NOW + 7);
      var page = sounds.page(null, NOW + 7);
      var groups = sounds.recent(NOW + 7);
      require(groups.size() == 2, "same-bin generic combat and priming merged");
      var cue = groups.getFirst();
      var generic = groups.get(1);
      require(cue.category() == 2 && "creeper_primed".equals(cue.cue())
          && cue.wallMillis() == (cueFirst ? WALL : WALL + 7)
          && generic.category() == 2 && generic.cue() == null
          && generic.wallMillis() == (cueFirst ? WALL + 7 : WALL)
          && cue.direction() == generic.direction() && cue.distance() == generic.distance(),
          "ordinary groups lost cue priority, separate bins or original timestamps");
      require(groups.equals(sounds.recent(NOW + 7))
          && page.equals(sounds.page(null, NOW + 7))
          && sounds.page(page.nextCursor(), NOW + 7).events().isEmpty()
          && groups.equals(sounds.recent(NOW + 7)),
          "ordinary and paged cue reads consumed each other's history");
      try {
        groups.clear();
        throw new AssertionError("caller could mutate ordinary sound groups");
      } catch (UnsupportedOperationException expected) {
        // Groups are immutable snapshots, independent of the retained ring.
      }
    }

    SoundProjection capped = new SoundProjection();
    double[][] offsets = {{0, -2}, {2, -2}, {2, 0}, {2, 2}, {0, 2}, {-2, 2}, {-2, 0}, {-2, -2}};
    for (int i = offsets.length - 1; i >= 0; i--)
      capped.accept(0, offsets[i][0], 0, offsets[i][1], WALL + i, NOW + i);
    capped.accept(5, 0, 0, 2, WALL + 8, NOW + 8);
    var groups = capped.recent(NOW + 8);
    require(groups.size() == 8 && "creeper_primed".equals(groups.getFirst().cue())
        && groups.getFirst().wallMillis() == WALL + 8,
        "eight generic bins masked a retained cue before the group cap");
    for (int i = 1; i < groups.size(); i++)
      require(groups.get(i).category() == 0 && groups.get(i).cue() == null
          && groups.get(i).direction() == i && groups.get(i).wallMillis() == WALL + i - 1,
          "generic remainder was not in deterministic bin order");
    var first = capped.page(null, NOW + 8);
    var last = capped.page(first.nextCursor(), NOW + 8);
    require(first.events().size() == 8 && first.hasMore() && last.events().size() == 1
        && "creeper_primed".equals(last.events().getFirst().cue())
        && !last.hasMore() && groups.equals(capped.recent(NOW + 8)),
        "ordinary cap discarded the paged cue or paged reads consumed ordinary groups");

    SoundProjection expiry = new SoundProjection();
    expiry.accept(5, 0, 0, 2, WALL, NOW);
    expiry.accept(2, 0, 0, 2, WALL + 7, NOW + 7);
    var boundary = expiry.recent(NOW + 1_000_000_000L);
    require(boundary.size() == 2 && "creeper_primed".equals(boundary.getFirst().cue())
        && boundary.getFirst().wallMillis() == WALL,
        "ordinary cue expired at the exact TTL boundary or borrowed generic time");
    var expired = expiry.recent(NOW + 1_000_000_001L);
    require(expired.size() == 1 && expired.getFirst().cue() == null
        && expired.getFirst().wallMillis() == WALL + 7,
        "newer same-bin generic combat refreshed an expired cue");
    var page = expiry.page(null, NOW + 1_000_000_001L);
    require(page.gap() && page.omittedBefore() == 1 && page.events().size() == 1
        && page.events().getFirst().cue() == null,
        "ordinary expiry consumed the generic event or concealed the expired cue's page gap");
    require(expiry.recent(NOW + 1_000_000_007L).size() == 1
        && expiry.recent(NOW + 1_000_000_008L).isEmpty(),
        "ordinary generic group lost its independent exact TTL boundary");
  }

  private static void allowlistAndAudibility() {
    SoundProjection sounds = new SoundProjection();
    String[] approved = {
      "minecraft:block.grass.step", "minecraft:entity.player.swim",
      "minecraft:block.stone.break", "minecraft:block.stone.place",
      "minecraft:block.wood.break", "minecraft:block.wood.place",
      "minecraft:entity.player.hurt", "minecraft:entity.generic.hurt",
      "minecraft:entity.generic.death", "minecraft:entity.arrow.shoot",
      "minecraft:entity.generic.explode", "minecraft:entity.zombie.ambient",
      "minecraft:entity.skeleton.ambient", "minecraft:entity.lightning_bolt.thunder"
    };
    int[] categories = {0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 4};
    for (int i = 0; i < approved.length; i++) {
      SoundProjection one = new SoundProjection();
      one.accept(approved[i], 0, 0, 2, WALL, NOW);
      var events = one.page(null, NOW).events();
      require(events.size() == 1 && events.getFirst().category() == categories[i]
          && events.getFirst().cue() == null, "old allowlist event/category was lost: " + approved[i]);
    }
    sounds.accept("minecraft:entity.creeper.primed", 0, 0, 2, WALL, NOW);
    sounds.accept("minecraft:entity.creeper.hurt", 0, 0, 2, WALL, NOW);
    sounds.accept("minecraft:entity.warden.heartbeat", 0, 0, 2, WALL, NOW);
    sounds.accept(6, 0, 0, 2, WALL, NOW);
    var primed = sounds.page(null, NOW).events();
    require(primed.size() == 1 && primed.getFirst().category() == 2
        && "creeper_primed".equals(primed.getFirst().cue())
        && primed.getFirst().nativeNanos() == NOW, "priming cue was absent or widened the allowlist");
    require(SoundProjection.audible(true, 1, 1, false, true, 16, 0, 0, 2),
        "actually playing audible source was excluded");
    require(!SoundProjection.audible(false, 1, 1, false, true, 16, 0, 0, 2),
        "nonplaying source was reported heard");
    require(!SoundProjection.audible(true, 0, 1, false, true, 16, 0, 0, 2)
        && !SoundProjection.audible(true, 1, 0, false, true, 16, 0, 0, 2),
        "muted source or master was reported heard");
    require(!SoundProjection.audible(true, 1, 1, true, true, 16, 0, 0, 2),
        "relative/UI source was reported heard");
    require(!SoundProjection.audible(true, 1, 1, false, true, 16, 0, 0, 16)
        && !SoundProjection.audible(true, 1, 1, false, true, 0, 0, 0, 2),
        "attenuation boundary or invalid cutoff was reported heard");
    require(SoundProjection.audible(true, 1, 1, false, false, 0, 0, 0, 32)
        && !SoundProjection.audible(true, 1, 1, false, false, 0, 0, 0, 32.001),
        "unattenuated source bypassed exact profile distance gate");
    require(!SoundProjection.audible(true, Double.NaN, 1, false, false, 0, 0, 0, 2)
        && !SoundProjection.audible(true, 1, Double.NaN, false, false, 0, 0, 0, 2),
        "nonfinite source/master gain was reported heard");
  }

  public static void main(String[] ignored) {
    independentReaders();
    overflowAndExpiry();
    scopeFences();
    binsAndLegacyPresence();
    ordinaryCueGroups();
    allowlistAndAudibility();
    System.out.println("Sound projection proof PASS: independent cursors, bounded pages, explicit gaps,"
        + " scope fencing, monotonic expiry, coarse bins, cue-distinct prioritized ordinary groups,"
        + " non-draining presence and audibility gates.");
  }
}
