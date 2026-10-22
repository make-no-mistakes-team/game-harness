package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.io.*;
import java.net.*;
import java.nio.*;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gl.Framebuffer;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.*;

/** Three fixed buffers: render never waits for the network; writer only consumes latest. */
public final class Video {
  private final ByteBuffer[] buffers = new ByteBuffer[3];
  private final byte[] transfer = new byte[65536];
  private final Object lock = new Object();
  private int ready = -1, writing = -1, sequence;
  private long nextCapture, renderStarted, renderCalls;
  private volatile boolean running = true;
  private volatile long captured,
      replaced,
      writeCount,
      readbackNanos,
      readbackMaxNanos,
      writeNanos,
      writeMaxNanos;

  public JsonObject metrics() {
    JsonObject m = new JsonObject();
    m.addProperty("render_calls", renderCalls);
    m.addProperty(
        "render_fps",
        renderStarted == 0 ? 0 : renderCalls * 1e9 / (System.nanoTime() - renderStarted));
    m.addProperty("captured_frames", captured);
    m.addProperty("latest_queue_replacements", replaced);
    m.addProperty("written_frames", writeCount);
    m.addProperty("readback_mean_ms", captured == 0 ? 0 : readbackNanos / 1e6 / captured);
    m.addProperty("readback_max_ms", readbackMaxNanos / 1e6);
    m.addProperty("write_mean_ms", writeCount == 0 ? 0 : writeNanos / 1e6 / writeCount);
    m.addProperty("write_max_ms", writeMaxNanos / 1e6);
    m.addProperty("fixed_frame_buffer_bytes", 3L * (32 + 1920 * 1080 * 4));
    return m;
  }

  public Video(JsonObject config) {
    for (int i = 0; i < 3; i++)
      buffers[i] =
          BufferUtils.createByteBuffer(32 + 1920 * 1080 * 4).order(ByteOrder.LITTLE_ENDIAN);
    Thread writer = new Thread(() -> write(config), "gameharness-video");
    writer.setDaemon(true);
    writer.start();
  }

  private void write(JsonObject config) {
    try (Socket socket =
        new Socket(InetAddress.getLoopbackAddress(), config.get("video_port").getAsInt())) {
      socket.setTcpNoDelay(true);
      socket.setSendBufferSize(65536);
      OutputStream out = socket.getOutputStream();
      out.write(
          (NativeClient.hello(config) + "\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
      while (running) {
        int index;
        synchronized (lock) {
          while (ready < 0 && running) lock.wait();
          if (!running) return;
          index = ready;
          ready = -1;
          writing = index;
        }
        ByteBuffer frame = buffers[index];
        frame.position(0);
        long writeStarted = System.nanoTime();
        while (frame.hasRemaining()) {
          int n = Math.min(frame.remaining(), transfer.length);
          frame.get(transfer, 0, n);
          out.write(transfer, 0, n);
        }
        long writeDuration = System.nanoTime() - writeStarted;
        writeNanos += writeDuration;
        writeMaxNanos = Math.max(writeMaxNanos, writeDuration);
        writeCount++;
        synchronized (lock) {
          writing = -1;
        }
      }
    } catch (Exception error) {
      running = false;
    }
  }

  public void capture() {
    long now = System.nanoTime();
    if (!running) return;
    MinecraftClient client = MinecraftClient.getInstance();
    if (client.world == null || client.player == null) return;
    if (renderStarted == 0) renderStarted = now;
    renderCalls++;
    if (now < nextCapture) return;
    nextCapture =
        nextCapture == 0 || now - nextCapture > 33333333L
            ? now + 33333333L
            : nextCapture + 33333333L;
    Framebuffer f = client.getFramebuffer();
    int w = f.textureWidth, h = f.textureHeight;
    if (w < 1 || h < 1 || w > 1920 || h > 1080) return;
    int index = -1;
    synchronized (lock) {
      for (int i = 0; i < 3; i++)
        if (i != writing && i != ready) {
          index = i;
          break;
        }
    }
    if (index < 0) return;
    ByteBuffer frame = buffers[index];
    frame.clear();
    frame.limit(32 + w * h * 4);
    frame
        .putInt(0x47485631)
        .putInt(w)
        .putInt(h)
        .putInt(w * h * 4)
        .putInt(++sequence)
        .putInt(1)
        .putDouble(System.currentTimeMillis());
    int read = GL11.glGetInteger(GL30.GL_READ_FRAMEBUFFER_BINDING),
        pack = GL11.glGetInteger(GL21.GL_PIXEL_PACK_BUFFER_BINDING),
        align = GL11.glGetInteger(GL11.GL_PACK_ALIGNMENT),
        row = GL11.glGetInteger(GL12.GL_PACK_ROW_LENGTH),
        skipRows = GL11.glGetInteger(GL11.GL_PACK_SKIP_ROWS),
        skipPixels = GL11.glGetInteger(GL11.GL_PACK_SKIP_PIXELS);
    long readbackStarted = System.nanoTime();
    try {
      GL30.glBindFramebuffer(GL30.GL_READ_FRAMEBUFFER, f.fbo);
      GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, 0);
      GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
      GL11.glPixelStorei(GL12.GL_PACK_ROW_LENGTH, 0);
      GL11.glPixelStorei(GL11.GL_PACK_SKIP_ROWS, 0);
      GL11.glPixelStorei(GL11.GL_PACK_SKIP_PIXELS, 0);
      GL11.glReadPixels(0, 0, w, h, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, frame);
    } finally {
      GL30.glBindFramebuffer(GL30.GL_READ_FRAMEBUFFER, read);
      GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, pack);
      GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, align);
      GL11.glPixelStorei(GL12.GL_PACK_ROW_LENGTH, row);
      GL11.glPixelStorei(GL11.GL_PACK_SKIP_ROWS, skipRows);
      GL11.glPixelStorei(GL11.GL_PACK_SKIP_PIXELS, skipPixels);
    }
    long readbackDuration = System.nanoTime() - readbackStarted;
    readbackNanos += readbackDuration;
    readbackMaxNanos = Math.max(readbackMaxNanos, readbackDuration);
    captured++;
    frame.position(0);
    synchronized (lock) {
      if (ready >= 0) replaced++;
      ready = index;
      lock.notifyAll();
    }
  }
}
