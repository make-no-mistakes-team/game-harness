package io.gameharness.nativeclient;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Objects;
import java.util.function.Consumer;

/** Single-owner control output with bounded ordinary traffic and one retirement ACK slot. */
public final class NativeControlWriter implements AutoCloseable {
  private static final int MAX_MESSAGES = 256;
  private static final int MAX_BYTES = 1024 * 1024;
  private static final int RESERVED_BYTES = 4096;
  private static final int ORDINARY_BYTES = MAX_BYTES - RESERVED_BYTES;

  private static final class Entry {
    final byte[] utf8;
    final Runnable written;
    final boolean reserved;
    final boolean telemetry;

    Entry(byte[] utf8, Runnable written, boolean reserved, boolean telemetry) {
      this.utf8 = utf8;
      this.written = written;
      this.reserved = reserved;
      this.telemetry = telemetry;
    }

    int bytes() { return utf8.length + 1; }
  }

  private final Object monitor = new Object();
  private final OutputStream output;
  private final Runnable abortTransport;
  private final Consumer<IOException> failed;
  // Reserved entries share this FIFO: they never overtake already accepted critical bytes.
  private final ArrayDeque<Entry> critical = new ArrayDeque<>(MAX_MESSAGES);
  private Entry pendingTelemetry;
  private Entry retainedTelemetry;
  private boolean reservedRetained;
  private boolean healthy = true;
  private int messages;
  private long bytes;
  private int ordinaryMessages;
  private long ordinaryBytes;
  private long omitted;

  public NativeControlWriter(OutputStream output, Runnable abortTransport, Consumer<IOException> failed) {
    this.output = Objects.requireNonNull(output, "output");
    this.abortTransport = Objects.requireNonNull(abortTransport, "abortTransport");
    this.failed = Objects.requireNonNull(failed, "failed");
    Thread owner = new Thread(this::writeLoop, "gameharness-control-writer");
    owner.setDaemon(true);
    owner.start();
  }

  public boolean critical(String jsonLine) {
    return enqueueCritical(jsonLine, null, false);
  }

  public boolean reserved(String jsonLine, Runnable written) {
    return enqueueCritical(jsonLine, written, true);
  }

  private boolean enqueueCritical(String line, Runnable written, boolean reserved) {
    synchronized (monitor) {
      if (!healthy) return false;
    }
    byte[] encoded = encode(line, reserved ? RESERVED_BYTES : ORDINARY_BYTES);
    if (encoded == null || (reserved && written == null)) {
      fail(new IOException("Invalid or oversized control line"));
      return false;
    }
    Entry entry = new Entry(encoded, written, reserved, false);
    boolean overflow;
    synchronized (monitor) {
      if (!healthy) return false;
      if (!reserved && !ordinaryFits(entry.bytes()) && pendingTelemetry != null) {
        Entry displaced = pendingTelemetry;
        pendingTelemetry = null;
        release(displaced);
        omitted++;
      }
      overflow = reserved
          ? reservedRetained || messages >= MAX_MESSAGES || bytes + entry.bytes() > MAX_BYTES
          : !ordinaryFits(entry.bytes());
      if (!overflow) {
        retain(entry);
        critical.addLast(entry);
        monitor.notifyAll();
        return true;
      }
      stop();
    }
    reportFailure(new IOException("Control writer retained capacity exceeded"));
    return false;
  }

  public boolean telemetry(String jsonLine) {
    synchronized (monitor) {
      if (!healthy) return false;
    }
    byte[] encoded = encode(jsonLine, ORDINARY_BYTES);
    synchronized (monitor) {
      if (!healthy) return false;
      if (encoded == null) {
        omitted++;
        return false;
      }
      if (pendingTelemetry != null) {
        Entry replaced = pendingTelemetry;
        pendingTelemetry = null;
        release(replaced);
        omitted++;
      } else if (retainedTelemetry != null) {
        // Bytes already being written are immutable, not replaceable pending telemetry.
        omitted++;
        return false;
      }
      if (!ordinaryFits(encoded.length + 1)) {
        omitted++;
        return false;
      }
      Entry entry = new Entry(encoded, null, false, true);
      retain(entry);
      pendingTelemetry = entry;
      monitor.notifyAll();
      return true;
    }
  }

  // Encode once, without concatenating/copying the string merely to append its newline.
  // The writer owns both payload and delimiter; accounting includes the delimiter throughout.
  private static byte[] encode(String line, int limit) {
    if (line == null || line.length() >= limit) return null;
    for (int index = 0; index < line.length(); index++) {
      char value = line.charAt(index);
      if (value == '\r' || value == '\n') return null;
    }
    byte[] encoded = line.getBytes(StandardCharsets.UTF_8);
    return encoded.length < limit ? encoded : null;
  }

  private boolean ordinaryFits(int size) {
    return ordinaryMessages < MAX_MESSAGES - 1 && ordinaryBytes + size <= ORDINARY_BYTES
        && messages < MAX_MESSAGES && bytes + size <= MAX_BYTES;
  }

  // All retain/release/stop operations run under monitor; dequeue does not release capacity.
  private void retain(Entry entry) {
    messages++;
    bytes += entry.bytes();
    if (entry.reserved) {
      reservedRetained = true;
    } else {
      ordinaryMessages++;
      ordinaryBytes += entry.bytes();
    }
    if (entry.telemetry) retainedTelemetry = entry;
  }

  private void release(Entry entry) {
    messages--;
    bytes -= entry.bytes();
    if (entry.reserved) {
      reservedRetained = false;
    } else {
      ordinaryMessages--;
      ordinaryBytes -= entry.bytes();
    }
    if (entry.telemetry) retainedTelemetry = null;
  }

  private void writeLoop() {
    try {
      while (true) {
        Entry entry;
        synchronized (monitor) {
          while (healthy && critical.isEmpty() && pendingTelemetry == null) monitor.wait();
          if (!healthy) return;
          if (!critical.isEmpty()) {
            entry = critical.removeFirst();
          } else {
            entry = pendingTelemetry;
            pendingTelemetry = null;
          }
        }
        output.write(entry.utf8);
        output.write('\n');
        output.flush();
        synchronized (monitor) {
          if (!healthy) return;
          release(entry);
        }
        if (entry.written != null) entry.written.run();
      }
    } catch (IOException error) {
      fail(error);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      fail(new IOException("Control writer interrupted", error));
    } catch (RuntimeException error) {
      fail(new IOException("Control writer output or completion callback failed", error));
    }
  }

  private void stop() {
    healthy = false;
    critical.clear();
    pendingTelemetry = null;
    retainedTelemetry = null;
    reservedRetained = false;
    messages = 0;
    bytes = 0;
    ordinaryMessages = 0;
    ordinaryBytes = 0;
    monitor.notifyAll();
  }

  private void fail(IOException error) {
    synchronized (monitor) {
      if (!healthy) return;
      stop();
    }
    reportFailure(error);
  }

  private void reportFailure(IOException error) {
    try {
      abortTransport.run();
    } finally {
      failed.accept(error);
    }
  }

  public boolean healthy() {
    synchronized (monitor) { return healthy; }
  }

  public int retainedMessages() {
    synchronized (monitor) { return messages; }
  }

  public long retainedBytes() {
    synchronized (monitor) { return bytes; }
  }

  public long telemetryOmitted() {
    synchronized (monitor) { return omitted; }
  }

  @Override public void close() {
    synchronized (monitor) {
      if (!healthy) return;
      stop();
    }
    // Closing the actual socket (supplied by its owner) must unblock any current write/flush.
    // No join: the game thread never waits for the writer thread to finish cancellation.
    abortTransport.run();
  }
}
