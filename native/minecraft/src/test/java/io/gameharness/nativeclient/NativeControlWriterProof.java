package io.gameharness.nativeclient;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Standard-Java ownership, bounded-retention and real TCP backpressure proofs. */
public final class NativeControlWriterProof {
  private static final int MAX_BYTES = 1024 * 1024;
  private static final int RESERVED_BYTES = 4096;
  private static final long DEADLINE_SECONDS = 10;

  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void await(CountDownLatch event, String message) throws InterruptedException {
    require(event.await(DEADLINE_SECONDS, TimeUnit.SECONDS), message);
  }

  private static void awaitOwner(Thread owner) throws InterruptedException {
    owner.join(TimeUnit.SECONDS.toMillis(DEADLINE_SECONDS));
    require(!owner.isAlive(), "cancelled writer owner did not terminate");
  }

  private static <T> T caller(java.util.concurrent.Callable<T> action) throws Exception {
    FutureTask<T> result = new FutureTask<>(action);
    Thread thread = new Thread(result, "proof-game-thread");
    thread.setDaemon(true);
    thread.start();
    try {
      return result.get(DEADLINE_SECONDS, TimeUnit.SECONDS);
    } catch (ExecutionException error) {
      if (error.getCause() instanceof Exception exception) throw exception;
      if (error.getCause() instanceof Error failure) throw failure;
      throw error;
    }
  }

  // A second thread must acquire the queue monitor while a callback is executing.
  private static void callbackCanInspect(NativeControlWriter writer) {
    try {
      caller(() -> {
        writer.healthy();
        writer.retainedMessages();
        writer.retainedBytes();
        writer.telemetryOmitted();
        return true;
      });
    } catch (Exception error) {
      throw new AssertionError("callback held queue monitor", error);
    }
  }

  private static final class ControlledOutput extends OutputStream {
    final CountDownLatch entered = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);
    final CountDownLatch exited = new CountDownLatch(1);
    final CountDownLatch flushed;
    final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    volatile boolean closed;
    volatile boolean failWrite;
    volatile Thread owner;

    ControlledOutput(int expectedFlushes) { flushed = new CountDownLatch(expectedFlushes); }

    @Override public void write(int value) throws IOException {
      write(new byte[] {(byte) value}, 0, 1);
    }

    @Override public void write(byte[] source, int offset, int length) throws IOException {
      owner = Thread.currentThread();
      entered.countDown();
      try {
        if (!release.await(DEADLINE_SECONDS, TimeUnit.SECONDS)) {
          throw new IOException("proof output never released");
        }
        if (closed || failWrite) throw new IOException("proof output aborted");
        synchronized (bytes) { bytes.write(source, offset, length); }
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IOException(error);
      } finally {
        exited.countDown();
      }
    }

    @Override public void flush() { flushed.countDown(); }
    @Override public void close() { closed = true; release.countDown(); }
    String text() {
      synchronized (bytes) { return bytes.toString(StandardCharsets.UTF_8); }
    }
  }

  private static void fifoAndTelemetryReplacement() throws Exception {
    ControlledOutput output = new ControlledOutput(5);
    AtomicInteger failures = new AtomicInteger();
    AtomicReference<Throwable> callbackError = new AtomicReference<>();
    AtomicReference<NativeControlWriter> reference = new AtomicReference<>();
    CountDownLatch acknowledged = new CountDownLatch(1);
    try (NativeControlWriter writer = new NativeControlWriter(output, output::close,
        error -> failures.incrementAndGet())) {
      reference.set(writer);
      require(caller(() -> writer.critical("first")), "initial critical rejected");
      await(output.entered, "writer did not enter blocked output");
      require(output.owner.isDaemon()
          && output.owner.getName().equals("gameharness-control-writer"), "output lacks daemon owner");
      require(caller(() -> writer.telemetry("old")), "first telemetry rejected");
      require(caller(() -> writer.telemetry("latest")), "replacement telemetry rejected");
      require(writer.telemetryOmitted() == 1, "replacement omission not counted");
      require(caller(() -> writer.critical("second")), "blocked output stalled caller");
      require(caller(() -> writer.reserved("ack", () -> {
        try {
          require(Thread.currentThread() == output.owner, "ACK callback not on writer owner");
          callbackCanInspect(reference.get());
          require(output.text().equals("first\nsecond\nack\n"), "reserved reordered older critical");
        } catch (Throwable error) {
          callbackError.set(error);
        } finally {
          acknowledged.countDown();
        }
      })), "reserved ACK rejected");
      require(caller(() -> writer.critical("third")), "critical after reserved rejected");
      require(acknowledged.getCount() == 1, "ACK callback ran at admission");
      require(writer.retainedMessages() == 5 && writer.retainedBytes() == 30,
          "in-flight or replaceable telemetry not retained exactly once");
      output.release.countDown();
      await(acknowledged, "reserved callback missing");
      await(output.flushed, "FIFO stream did not flush");
      if (callbackError.get() != null) throw new AssertionError(callbackError.get());
      require(output.text().equals("first\nsecond\nack\nthird\nlatest\n"),
          "telemetry delayed critical or critical FIFO bytes changed");
      require(failures.get() == 0, "successful writer failed");
    }
  }

  private static void messageReserveAndOverflow() throws Exception {
    ControlledOutput output = new ControlledOutput(0);
    AtomicInteger aborts = new AtomicInteger();
    AtomicInteger failures = new AtomicInteger();
    AtomicReference<NativeControlWriter> reference = new AtomicReference<>();
    CountDownLatch failed = new CountDownLatch(1);
    try (NativeControlWriter writer = new NativeControlWriter(output, () -> {
      callbackCanInspect(reference.get());
      aborts.incrementAndGet();
      output.close();
    }, error -> {
      callbackCanInspect(reference.get());
      failures.incrementAndGet();
      failed.countDown();
    })) {
      reference.set(writer);
      require(writer.critical("x"), "first critical rejected");
      await(output.entered, "output did not block");
      for (int index = 1; index < 255; index++) {
        require(caller(() -> writer.critical("x")), "ordinary capacity excluded valid message");
      }
      require(writer.retainedMessages() == 255 && writer.retainedBytes() == 510,
          "dequeued in-flight message escaped accounting");
      require(!caller(() -> writer.telemetry("omitted")), "full ordinary lane accepted telemetry");
      require(writer.telemetryOmitted() == 1 && writer.healthy(), "telemetry overload killed transport");
      require(caller(() -> writer.reserved("r".repeat(4095), () -> {
        throw new AssertionError("unwritten reserved callback ran");
      })), "ordinary saturation consumed reserved ACK slot");
      require(writer.retainedMessages() == 256 && writer.retainedBytes() == 4606,
          "reserved/in-flight retention bound incorrect");
      require(!caller(() -> writer.critical("overflow")), "critical overflow silently admitted");
      await(failed, "critical overflow did not report failure");
      require(!writer.healthy() && !writer.critical("later") && !writer.telemetry("later"),
          "overflow failed to permanently fence admission");
      require(!writer.reserved("later", () -> {}), "overflow admitted reserved bytes");
      require(aborts.get() == 1 && failures.get() == 1, "failure/abort not exactly once");
      require(writer.retainedMessages() <= 256 && writer.retainedBytes() <= MAX_BYTES,
          "overflow escaped hard bounds");
    }
    require(aborts.get() == 1 && failures.get() == 1, "close duplicated failure abort");
  }

  private static void byteReserveAndUtf8() throws Exception {
    ControlledOutput output = new ControlledOutput(0);
    AtomicInteger callbacks = new AtomicInteger();
    try (NativeControlWriter writer = new NativeControlWriter(output, output::close,
        error -> callbacks.incrementAndGet())) {
      // U+00E9 is two UTF8 bytes, plus a final ASCII byte and newline.
      String ordinary = "é".repeat((MAX_BYTES - RESERVED_BYTES - 2) / 2) + "x";
      require(writer.critical(ordinary), "maximum ordinary UTF8 bytes rejected");
      await(output.entered, "large write did not block");
      require(writer.retainedBytes() == 1044480, "UTF8 bytes counted as UTF16 characters");
      require(!writer.telemetry("x"), "telemetry consumed reserved byte headroom");
      require(writer.healthy() && writer.telemetryOmitted() == 1, "byte omission was not explicit");
      require(writer.reserved("r".repeat(4095), () -> callbacks.incrementAndGet()),
          "4096-byte ACK rejected at ordinary byte saturation");
      require(writer.retainedBytes() == MAX_BYTES && writer.retainedMessages() == 2,
          "in-flight byte accounting violated exact 1 MiB bound");
    }
    await(output.exited, "close did not unblock oversized in-flight write");
    awaitOwner(output.owner);
    require(callbacks.get() == 0, "close fabricated success/failure for cancelled bytes");
  }

  private static void invalidCriticalAndReservedFence() throws Exception {
    String[] bad = {"one\ntwo", "one\rtwo", "x".repeat(MAX_BYTES - RESERVED_BYTES), null};
    for (String line : bad) {
      AtomicInteger failures = new AtomicInteger();
      AtomicInteger aborts = new AtomicInteger();
      try (NativeControlWriter writer = new NativeControlWriter(new ByteArrayOutputStream(),
          aborts::incrementAndGet, error -> failures.incrementAndGet())) {
        require(!writer.critical(line), "invalid critical accepted");
        require(!writer.healthy() && failures.get() == 1 && aborts.get() == 1,
            "invalid critical failed to fence exactly once");
        require(!writer.critical("valid") && failures.get() == 1, "invalid-line fence reset");
      }
    }
    AtomicInteger failures = new AtomicInteger();
    try (NativeControlWriter writer = new NativeControlWriter(new ByteArrayOutputStream(),
        () -> {}, error -> failures.incrementAndGet())) {
      require(!writer.reserved("x".repeat(4096), () -> {}), "oversized reserved line accepted");
      require(!writer.healthy() && failures.get() == 1, "reserved oversize did not fence");
    }
  }

  private static void telemetryCannotOccupyCriticalCapacity() throws Exception {
    ControlledOutput output = new ControlledOutput(0);
    try (NativeControlWriter writer = new NativeControlWriter(output, output::close,
        error -> { throw new AssertionError(error); })) {
      require(writer.critical("x"), "initial critical rejected");
      await(output.entered, "output did not block");
      require(writer.telemetry("replaceable"), "telemetry rejected below capacity");
      for (int index = 1; index < 255; index++) {
        require(writer.critical("x"), "pending telemetry denied critical capacity");
      }
      require(writer.healthy() && writer.retainedMessages() == 255 && writer.telemetryOmitted() == 1,
          "critical did not omit pending telemetry at capacity");
      require(!writer.telemetry("bad\nline") && !writer.telemetry("x".repeat(MAX_BYTES)),
          "invalid telemetry admitted");
      require(writer.telemetryOmitted() == 3 && writer.healthy(), "invalid telemetry fenced transport");
    }
  }

  private static void retainedSlotsIncludeInFlight() throws Exception {
    ControlledOutput telemetryOutput = new ControlledOutput(2);
    try (NativeControlWriter writer = new NativeControlWriter(telemetryOutput, telemetryOutput::close,
        error -> { throw new AssertionError(error); })) {
      require(writer.telemetry("already-sending"), "initial telemetry rejected");
      await(telemetryOutput.entered, "telemetry did not enter output");
      require(!writer.telemetry("cannot-replace-sent-bytes"), "two telemetry messages retained");
      require(writer.telemetryOmitted() == 1 && writer.retainedMessages() == 1,
          "in-flight telemetry escaped omission accounting");
      require(writer.critical("critical"), "in-flight telemetry blocked critical admission");
      telemetryOutput.release.countDown();
      await(telemetryOutput.flushed, "telemetry/critical did not flush");
      require(telemetryOutput.text().equals("already-sending\ncritical\n"),
          "in-flight telemetry bytes were replaced");
    }

    ControlledOutput reservedOutput = new ControlledOutput(0);
    AtomicInteger failures = new AtomicInteger();
    AtomicInteger successes = new AtomicInteger();
    try (NativeControlWriter writer = new NativeControlWriter(reservedOutput, reservedOutput::close,
        error -> failures.incrementAndGet())) {
      require(writer.reserved("first", successes::incrementAndGet), "initial reserved rejected");
      await(reservedOutput.entered, "reserved did not enter output");
      require(!writer.reserved("second", successes::incrementAndGet),
          "second retained reserved accepted while first in flight");
      require(!writer.healthy() && failures.get() == 1 && successes.get() == 0,
          "reserved overflow failed to fence without fabricated completion");
    }
  }

  private static void callbackWaitsForFlush() throws Exception {
    CountDownLatch flushing = new CountDownLatch(1);
    CountDownLatch releaseFlush = new CountDownLatch(1);
    CountDownLatch callback = new CountDownLatch(1);
    OutputStream output = new ByteArrayOutputStream() {
      @Override public void flush() throws IOException {
        flushing.countDown();
        try {
          if (!releaseFlush.await(DEADLINE_SECONDS, TimeUnit.SECONDS)) throw new IOException("flush stuck");
        } catch (InterruptedException error) {
          Thread.currentThread().interrupt();
          throw new IOException(error);
        }
      }
    };
    try (NativeControlWriter writer = new NativeControlWriter(output, releaseFlush::countDown,
        error -> { throw new AssertionError(error); })) {
      require(writer.reserved("ack", callback::countDown), "ACK admission failed");
      await(flushing, "writer did not flush");
      require(callback.getCount() == 1 && writer.retainedMessages() == 1,
          "write but not flush falsely confirmed ACK");
      releaseFlush.countDown();
      await(callback, "flushed ACK callback missing");
    }
  }

  private static void closeCancelsAndFailureOnce() throws Exception {
    ControlledOutput output = new ControlledOutput(0);
    AtomicInteger aborts = new AtomicInteger();
    AtomicInteger failures = new AtomicInteger();
    AtomicInteger successes = new AtomicInteger();
    NativeControlWriter writer = new NativeControlWriter(output, () -> {
      aborts.incrementAndGet();
      output.close();
    }, error -> failures.incrementAndGet());
    require(writer.critical("blocked"), "initial admission failed");
    await(output.entered, "output did not block");
    require(writer.reserved("pending", successes::incrementAndGet), "pending ACK rejected");
    caller(() -> { writer.close(); return true; });
    await(output.exited, "close did not unblock actual output");
    awaitOwner(output.owner);
    require(!writer.healthy() && !writer.critical("later"), "close allowed later admission");
    require(writer.retainedMessages() == 0 && writer.retainedBytes() == 0,
        "close retained cancelled messages");
    writer.close();
    require(aborts.get() == 1 && failures.get() == 0 && successes.get() == 0,
        "close duplicated abort or invented ACK/failure");

    ControlledOutput broken = new ControlledOutput(0);
    CountDownLatch failed = new CountDownLatch(1);
    AtomicInteger writeFailures = new AtomicInteger();
    try (NativeControlWriter failing = new NativeControlWriter(broken, broken::close, error -> {
      writeFailures.incrementAndGet();
      failed.countDown();
    })) {
      require(failing.critical("broken"), "broken stream not admitted initially");
      await(broken.entered, "broken output did not start");
      broken.failWrite = true;
      broken.release.countDown();
      await(failed, "write exception did not fail transport");
      require(!failing.healthy() && !failing.critical("later") && writeFailures.get() == 1,
          "write exception did not permanently fence once");
    }
    require(writeFailures.get() == 1, "close repeated write failure");
  }

  private static void closeCancelsBlockedFlush() throws Exception {
    CountDownLatch flushing = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    AtomicReference<Thread> owner = new AtomicReference<>();
    AtomicInteger successes = new AtomicInteger();
    AtomicInteger failures = new AtomicInteger();
    OutputStream output = new ByteArrayOutputStream() {
      @Override public void flush() throws IOException {
        owner.set(Thread.currentThread());
        flushing.countDown();
        try {
          if (!release.await(DEADLINE_SECONDS, TimeUnit.SECONDS)) throw new IOException("flush stuck");
        } catch (InterruptedException error) {
          Thread.currentThread().interrupt();
          throw new IOException(error);
        }
      }
    };
    try (NativeControlWriter writer = new NativeControlWriter(output, release::countDown,
        error -> failures.incrementAndGet())) {
      require(writer.reserved("unconfirmed", successes::incrementAndGet), "reserved admission failed");
      await(flushing, "reserved did not enter flush");
      caller(() -> { writer.close(); return true; });
      awaitOwner(owner.get());
      require(successes.get() == 0 && failures.get() == 0,
          "cancelled flush fabricated confirmation or transport failure");
    }
  }

  private static final class SocketOutput extends OutputStream {
    final Socket socket;
    final OutputStream output;
    final CountDownLatch entered = new CountDownLatch(1);
    final CountDownLatch exited = new CountDownLatch(1);
    volatile Thread owner;
    SocketOutput(Socket socket) throws IOException {
      this.socket = socket;
      output = socket.getOutputStream();
    }
    @Override public void write(int value) throws IOException { output.write(value); }
    @Override public void write(byte[] value, int offset, int length) throws IOException {
      owner = Thread.currentThread();
      entered.countDown();
      try { output.write(value, offset, length); } finally { exited.countDown(); }
    }
    @Override public void flush() throws IOException { output.flush(); }
    void abort() {
      try { socket.close(); } catch (IOException error) { throw new AssertionError(error); }
    }
  }

  private static void realLoopbackSlowReader() throws Exception {
    InetAddress loopback = InetAddress.getLoopbackAddress();
    try (ServerSocket server = new ServerSocket()) {
      server.setReceiveBufferSize(1024);
      server.bind(new java.net.InetSocketAddress(loopback, 0));
      try (Socket sender = new Socket()) {
        sender.setSendBufferSize(1024);
        sender.connect(server.getLocalSocketAddress());
        try (Socket reader = server.accept()) {
          reader.setReceiveBufferSize(1024);
          // The real peer deliberately reads zero bytes until cancellation. Retention proves
          // the 1 MiB write remains in flight rather than relying on a sleep/timing guess.
          SocketOutput output = new SocketOutput(sender);
          AtomicInteger failures = new AtomicInteger();
          AtomicInteger successes = new AtomicInteger();
          NativeControlWriter writer = new NativeControlWriter(output, output::abort,
              error -> failures.incrementAndGet());
          try {
            require(caller(() -> writer.critical("x".repeat(MAX_BYTES - RESERVED_BYTES - 1))),
                "real socket write blocked caller");
            await(output.entered, "loopback owner did not enter socket write");
            require(writer.retainedMessages() == 1 && writer.retainedBytes() == 1044480,
                "loopback backpressure failed to retain in-flight bytes");
            require(caller(() -> writer.reserved("retire", successes::incrementAndGet)),
                "slow reader stalled reserved admission");
            require(writer.retainedMessages() == 2 && writer.retainedBytes() == 1044487,
                "slow-reader reserved capacity not bounded/accounted");
            require(output.exited.getCount() == 1 && successes.get() == 0,
                "loopback fixture did not actually produce slow-reader backpressure");
            caller(() -> { writer.close(); return true; });
            await(output.exited, "socket abort failed to unblock real in-flight output");
            awaitOwner(output.owner);
            require(writer.retainedMessages() == 0 && !writer.healthy()
                && successes.get() == 0 && failures.get() == 0,
                "slow-reader close invented success or retained cancelled data");
          } finally {
            writer.close();
          }
        }
      }
    }
  }

  public static void main(String[] ignored) throws Exception {
    fifoAndTelemetryReplacement();
    messageReserveAndOverflow();
    byteReserveAndUtf8();
    invalidCriticalAndReservedFence();
    telemetryCannotOccupyCriticalCapacity();
    retainedSlotsIncludeInFlight();
    callbackWaitsForFlush();
    closeCancelsAndFailureOnce();
    closeCancelsBlockedFlush();
    realLoopbackSlowReader();
  }
}
