package io.gameharness.nativeclient;

/** Visual position only: retaining a pointer never retains input ownership or pressed buttons. */
public final class VisiblePointerPosition {
  private Object screen, handler;
  private long window;
  private int width, height;
  private double x, y;

  public void begin(Object screen, Object handler, long window, int width, int height, double seedX, double seedY) {
    if (matches(screen, handler, window, width, height)) return;
    if (screen == null || handler == null || width <= 0 || height <= 0
        || !Double.isFinite(seedX) || !Double.isFinite(seedY))
      throw new IllegalArgumentException("Visible pointer needs a current screen, handler and finite viewport position");
    this.screen = screen; this.handler = handler; this.window = window; this.width = width; this.height = height;
    x = seedX; y = seedY;
  }

  public boolean matches(Object screen, Object handler, long window, int width, int height) {
    return this.screen != null && this.screen == screen && this.handler == handler
        && this.window == window && this.width == width && this.height == height;
  }

  public void update(Object screen, Object handler, long window, int width, int height, double x, double y) {
    if (!matches(screen, handler, window, width, height)) return;
    if (!Double.isFinite(x) || !Double.isFinite(y)) throw new IllegalArgumentException("Visible pointer position must be finite");
    this.x = x; this.y = y;
  }

  public double x() { return x; }
  public double y() { return y; }

  public void clear() {
    screen = handler = null; window = 0; width = height = 0; x = y = 0;
  }
}
