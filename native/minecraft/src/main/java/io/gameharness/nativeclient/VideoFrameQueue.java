package io.gameharness.nativeclient;

/** Index ownership for one render producer, one socket writer and three fixed framebuffers. */
final class VideoFrameQueue {
  static final int CAPACITY = 3;
  private final int[] ready = new int[CAPACITY];
  private int head, size, occupied;
  private int filling = -1, writing = -1;
  private boolean closed;
  private long replacements;

  synchronized int acquire() {
    if (closed) return -1;
    if (filling >= 0) throw new IllegalStateException("Capture already owns a framebuffer");
    int free = ~occupied & ((1 << CAPACITY) - 1);
    int index;
    if (free == 0) {
      // Never wait for or overwrite the socket owner. Only a queued packet can be evicted.
      index = removeReady();
      replacements++;
    } else {
      index = Integer.numberOfTrailingZeros(free);
      occupied |= 1 << index;
    }
    filling = index;
    return index;
  }

  synchronized void publish(int index) {
    if (index < 0 || filling != index) throw new IllegalStateException("Capture buffer ownership changed");
    filling = -1;
    if (closed) { occupied &= ~(1 << index); return; }
    ready[(head + size) % CAPACITY] = index;
    size++;
    notifyAll();
  }

  synchronized int take() throws InterruptedException {
    if (writing >= 0) throw new IllegalStateException("Socket already owns a framebuffer");
    while (size == 0 && !closed) wait();
    if (closed) return -1;
    writing = removeReady();
    return writing;
  }

  synchronized void release(int index) {
    if (index < 0 || writing != index) throw new IllegalStateException("Socket buffer ownership changed");
    writing = -1;
    occupied &= ~(1 << index);
  }

  synchronized long replacements() { return replacements; }

  synchronized void close() {
    closed = true;
    notifyAll();
  }

  private int removeReady() {
    if (size == 0) throw new IllegalStateException("No pending framebuffer to transfer");
    int index = ready[head];
    head = (head + 1) % CAPACITY;
    size--;
    return index;
  }
}
