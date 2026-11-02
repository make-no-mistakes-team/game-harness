package io.gameharness.nativeclient;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/** Exercises packet retention and buffer ownership without an OpenGL context. */
public final class VideoFrameQueueProof {
  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static void publish(VideoFrameQueue queue, int[] pixels, int sequence) {
    int slot = queue.acquire();
    require(slot >= 0, "open producer could not acquire a buffer");
    pixels[slot] = sequence;
    queue.publish(slot);
  }

  private static void briefWriterStall() throws Exception {
    VideoFrameQueue queue = new VideoFrameQueue();
    int[] pixels = new int[3];
    publish(queue, pixels, 67);
    int writing = queue.take();
    publish(queue, pixels, 68);
    publish(queue, pixels, 69);
    require(pixels[writing] == 67, "render overwrote the socket-owned packet");
    queue.release(writing);
    int next = queue.take();
    require(pixels[next] == 68, "brief stalled write lost the first waiting capture");
    queue.release(next);
    next = queue.take();
    require(pixels[next] == 69, "brief stalled write reordered the second waiting capture");
    queue.release(next);
    require(queue.replacements() == 0, "free fixed buffer was counted as an eviction");
    queue.close();
  }

  private static void saturatedWriterRetainsNewest() throws Exception {
    VideoFrameQueue queue = new VideoFrameQueue();
    int[] pixels = new int[3];
    publish(queue, pixels, 1);
    int writing = queue.take();
    publish(queue, pixels, 2);
    publish(queue, pixels, 3);
    publish(queue, pixels, 4);
    publish(queue, pixels, 5);
    require(pixels[writing] == 1, "saturation reused a socket-owned buffer");
    require(queue.replacements() == 2, "saturation did not count both discarded captures");
    queue.release(writing);
    int next = queue.take();
    require(pixels[next] == 4, "saturation failed to evict the oldest pending capture");
    queue.release(next);
    next = queue.take();
    require(pixels[next] == 5, "saturation lost the newest capture");
    queue.release(next);
    queue.close();
  }

  private static void releasedBuffersRemainExclusive() throws Exception {
    VideoFrameQueue queue = new VideoFrameQueue();
    int[] pixels = new int[3];
    for (int sequence = 1; sequence <= 1000; sequence += 2) {
      publish(queue, pixels, sequence);
      int writing = queue.take();
      publish(queue, pixels, sequence + 1);
      require(pixels[writing] == sequence, "publication recycled an in-flight buffer");
      queue.release(writing);
      int next = queue.take();
      require(pixels[next] == sequence + 1, "released-slot reuse returned stale packet content");
      queue.release(next);
    }
    require(queue.replacements() == 0, "consumer keeping pace still lost packets");
    queue.close();
  }

  private static void waitingConsumerWakesForPublicationAndClose() throws Exception {
    VideoFrameQueue queue = new VideoFrameQueue();
    CountDownLatch entered = new CountDownLatch(1);
    FutureTask<Integer> first = new FutureTask<>(() -> { entered.countDown(); return queue.take(); });
    Thread owner = new Thread(first, "proof-video-writer");
    owner.setDaemon(true);
    owner.start();
    try {
      require(entered.await(5, TimeUnit.SECONDS), "consumer did not start");
      int slot = queue.acquire();
      queue.publish(slot);
      int taken = first.get(5, TimeUnit.SECONDS);
      require(taken == slot, "idle writer missed the published buffer");
      queue.release(taken);
      owner.join(5000);
      require(!owner.isAlive(), "publication left the writer owner running");
      FutureTask<Integer> second = new FutureTask<>(queue::take);
      Thread idle = new Thread(second, "proof-idle-video-writer");
      idle.setDaemon(true);
      idle.start();
      queue.close();
      require(second.get(5, TimeUnit.SECONDS) == -1, "closed idle writer did not terminate");
      idle.join(5000);
      require(!idle.isAlive(), "close stranded a waiting writer");
      require(queue.acquire() == -1, "closed producer reacquired a framebuffer");
    } finally {
      queue.close();
      owner.join(5000);
    }
  }

  private static void closeDuringReadbackDoesNotPublish() throws Exception {
    VideoFrameQueue queue = new VideoFrameQueue();
    int filling = queue.acquire();
    queue.close();
    queue.publish(filling);
    require(queue.take() == -1, "late render publication reopened a failed stream");
    require(queue.acquire() == -1, "late publication revived the producer");
  }

  private static void concurrentOwnershipAndLossAccounting() throws Exception {
    VideoFrameQueue queue = new VideoFrameQueue();
    int[] pixels = new int[3];
    FutureTask<Integer> consumption = new FutureTask<>(() -> {
      int last = 0, delivered = 0;
      while (last < 2000) {
        int slot = queue.take();
        require(slot >= 0, "stream closed before the newest packet arrived");
        int sequence = pixels[slot];
        require(sequence > last, "concurrent writer received duplicate or reordered content");
        Thread.yield();
        require(pixels[slot] == sequence, "producer overwrote a concurrently held packet");
        last = sequence;
        delivered++;
        queue.release(slot);
      }
      return delivered;
    });
    Thread owner = new Thread(consumption, "proof-concurrent-video-writer");
    owner.setDaemon(true);
    owner.start();
    try {
      for (int sequence = 1; sequence <= 2000; sequence++) publish(queue, pixels, sequence);
      int delivered = consumption.get(5, TimeUnit.SECONDS);
      require(delivered + queue.replacements() == 2000, "a capture disappeared without loss accounting");
    } finally {
      queue.close();
      owner.join(5000);
    }
    require(!owner.isAlive(), "concurrent writer did not terminate");
  }

  public static void main(String[] ignored) {
    try {
      briefWriterStall();
      saturatedWriterRetainsNewest();
      releasedBuffersRemainExclusive();
      waitingConsumerWakesForPublicationAndClose();
      closeDuringReadbackDoesNotPublish();
      concurrentOwnershipAndLossAccounting();
      System.out.println("Video frame queue proof passed");
    } catch (Exception error) {
      throw new AssertionError("Video frame queue proof failed", error);
    }
  }
}
