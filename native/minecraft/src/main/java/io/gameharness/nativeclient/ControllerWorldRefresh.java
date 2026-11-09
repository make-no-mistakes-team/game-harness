package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.util.Objects;
import java.util.function.LongFunction;

/** Game-thread terrain cache. Current dynamic sensing is a separate per-tick acquisition. */
public final class ControllerWorldRefresh {
  private static final long INTERVAL_NS = 500_000_000L;
  private static final long MAX_AGE_NS = 1_000_000_000L;
  private final LongFunction<JsonObject> acquisition;
  private JsonObject cached;
  private long life, attemptedAt, acquiredAt;
  private EffectAuthority.Space space;
  private EffectAuthority.Screen screen;
  private boolean scoped, attempted;

  public ControllerWorldRefresh(LongFunction<JsonObject> acquisition) {
    this.acquisition = Objects.requireNonNull(acquisition);
  }

  /** Sampling may acquire geometry at most twice per second within one sensing scope. */
  public JsonObject sample(long now, long life, EffectAuthority.Space space, EffectAuthority.Screen screen) {
    scope(life, space, screen);
    long elapsed = now - attemptedAt;
    if (!attempted || elapsed < 0 || elapsed >= INTERVAL_NS) acquire(now);
    return current(now);
  }

  /** Explicit strategic observations stay fresh and also seed the controller's shared cache. */
  public JsonObject observe(long now, long life, EffectAuthority.Space space, EffectAuthority.Screen screen) {
    scope(life, space, screen);
    acquire(now);
    return current(now);
  }

  /** Read the terrain cache without acquiring or relabelling its original time. */
  public JsonObject retained(long now, long life, EffectAuthority.Space space, EffectAuthority.Screen screen) {
    scope(life, space, screen);
    return current(now);
  }

  public void invalidate() {
    cached = null;
    space = null;
    screen = null;
    scoped = false;
    attempted = false;
  }

  private void scope(long life, EffectAuthority.Space space, EffectAuthority.Screen screen) {
    Objects.requireNonNull(space);
    if (scoped && this.life == life && this.space.equals(space) && Objects.equals(this.screen, screen)) return;
    invalidate();
    this.life = life;
    this.space = space;
    this.screen = screen;
    scoped = true;
  }

  private void acquire(long now) {
    // A failed scan cannot trigger an unbounded retry at the controller's sample frequency.
    attempted = true;
    attemptedAt = now;
    JsonObject projection = Objects.requireNonNull(acquisition.apply(now));
    cached = projection;
    acquiredAt = now;
  }

  private JsonObject current(long now) {
    if (cached == null) return null;
    long age = now - acquiredAt;
    cached.addProperty("stale", age < 0 || age > MAX_AGE_NS);
    return cached;
  }
}
