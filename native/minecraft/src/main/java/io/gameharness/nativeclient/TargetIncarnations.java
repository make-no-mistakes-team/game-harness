package io.gameharness.nativeclient;

import java.util.LinkedHashMap;
import java.util.Objects;
import java.util.UUID;

/** Bounded game-thread target handles, independent of position equality or registry material names. */
public final class TargetIncarnations<Key> {
  public record Target(String targetId, long incarnation, EffectAuthority.Space space, long lifeId) {
    public Target {
      ContractIdentity.id(targetId); ContractIdentity.checked(incarnation);
      Objects.requireNonNull(space); ContractIdentity.checked(lifeId);
    }
  }
  private final int maximum;
  private final LinkedHashMap<Key, Target> targets = new LinkedHashMap<>();
  private final java.util.HashSet<Key> pinned = new java.util.HashSet<>();
  private long incarnation;

  public TargetIncarnations(int maximum) {
    if (maximum < 1 || maximum > 1024) throw new IllegalArgumentException("Target retention must be bounded");
    this.maximum = maximum;
  }

  public Target observe(Key key, EffectAuthority.Space space, long lifeId) {
    Objects.requireNonNull(key);
    Objects.requireNonNull(space);
    ContractIdentity.checked(lifeId);
    Target previous = targets.get(key);
    if (previous != null && previous.lifeId() == lifeId && previous.space().equals(space)) return previous;
    if (previous == null && targets.size() == maximum) {
      var candidates = targets.keySet().iterator();
      boolean evicted = false;
      while (candidates.hasNext()) {
        if (!pinned.contains(candidates.next())) { candidates.remove(); evicted = true; break; }
      }
      if (!evicted) throw new IllegalStateException("Target registry has no unpinned capacity");
    }
    incarnation = ContractIdentity.next(incarnation);
    Target target = new Target(UUID.randomUUID().toString(), incarnation, space, lifeId);
    targets.put(key, target);
    return target;
  }

  /** An actual block/entity replacement/removal signal, including replacement with the same material. */
  public void replaced(Key key) { targets.remove(key); pinned.remove(key); }

  /** Only admitted mechanical owners may pin; observation alone never acquires custody. */
  public void pin(Key key, Target expected) {
    if (!expected.equals(targets.get(key))) throw new IllegalStateException("Cannot pin an obsolete target");
    if (!pinned.contains(key) && pinned.size() >= 4) throw new IllegalStateException("Active target pin bound reached");
    pinned.add(key);
  }

  public void unpin(Key key) { pinned.remove(key); }

  /** Loading/uncertain transition, relocation or life change fences every retained handle. */
  public void invalidate() { targets.clear(); pinned.clear(); }

  public boolean current(Key key, Target expected, EffectAuthority.Space space, long lifeId) {
    if (expected == null || space == null || expected.lifeId() != lifeId || !expected.space().equals(space)) return false;
    Target actual = targets.get(key);
    return expected.equals(actual);
  }
}
