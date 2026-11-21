package io.gameharness.survival;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import net.minecraft.client.gl.Framebuffer;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;
import org.lwjgl.opengl.GL15;
import org.lwjgl.opengl.GL21;
import org.lwjgl.opengl.GL30;
import org.lwjgl.system.MemoryUtil;

final class AgentVisualImage {
    private AgentVisualImage() {}

    static boolean dimensions(int width, int height) {
        return width > 0 && height > 0 && width <= 1920 && height <= 1080;
    }

    /** Same native framebuffer and pack-state preservation as Video.capture. Owns the returned buffer. */
    static ByteBuffer read(Framebuffer frame) {
        int width = frame.viewportWidth, height = frame.viewportHeight;
        if (!dimensions(width, height) || width != frame.textureWidth || height != frame.textureHeight)
            return null;
        int read = GL11.glGetInteger(GL30.GL_READ_FRAMEBUFFER_BINDING);
        int pack = GL11.glGetInteger(GL21.GL_PIXEL_PACK_BUFFER_BINDING);
        int align = GL11.glGetInteger(GL11.GL_PACK_ALIGNMENT), row = GL11.glGetInteger(GL12.GL_PACK_ROW_LENGTH);
        int skipRows = GL11.glGetInteger(GL12.GL_PACK_SKIP_ROWS), skipPixels = GL11.glGetInteger(GL12.GL_PACK_SKIP_PIXELS);
        // Never publish uninitialized native memory if a driver refuses the readback.
        var pixels = MemoryUtil.memCalloc(width * height * 4);
        boolean success = false;
        try {
            try {
                GL30.glBindFramebuffer(GL30.GL_READ_FRAMEBUFFER, frame.fbo);
                if (GL30.glCheckFramebufferStatus(GL30.GL_READ_FRAMEBUFFER) != GL30.GL_FRAMEBUFFER_COMPLETE
                        || GL11.glGetInteger(GL11.GL_READ_BUFFER) != GL30.GL_COLOR_ATTACHMENT0) return null;
                GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, 0);
                GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
                GL11.glPixelStorei(GL12.GL_PACK_ROW_LENGTH, 0);
                GL11.glPixelStorei(GL12.GL_PACK_SKIP_ROWS, 0);
                GL11.glPixelStorei(GL12.GL_PACK_SKIP_PIXELS, 0);
                GL11.glReadPixels(0, 0, width, height, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixels);
                if (GL11.glGetError() != GL11.GL_NO_ERROR) return null;
            } finally {
                GL30.glBindFramebuffer(GL30.GL_READ_FRAMEBUFFER, read);
                GL15.glBindBuffer(GL21.GL_PIXEL_PACK_BUFFER, pack);
                GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, align);
                GL11.glPixelStorei(GL12.GL_PACK_ROW_LENGTH, row);
                GL11.glPixelStorei(GL12.GL_PACK_SKIP_ROWS, skipRows);
                GL11.glPixelStorei(GL12.GL_PACK_SKIP_PIXELS, skipPixels);
            }
            success = true;
            return pixels;
        } finally {
            if (!success) MemoryUtil.memFree(pixels);
        }
    }

    /** Off-thread. A single vertical flip preserves the full rendered width, height, FOV and orientation. */
    static String encode(ByteBuffer rgba, int width, int height, Path output) throws IOException {
        if (!dimensions(width, height) || rgba.remaining() != width * height * 4)
            throw new IOException("Invalid visual readback dimensions");
        var image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        int[] rgb = ((DataBufferInt) image.getRaster().getDataBuffer()).getData();
        for (int y = height - 1, next = 0; y >= 0; --y) {
            for (int i = y * width * 4, end = i + width * 4; i < end; i += 4) {
                rgb[next++] = (Byte.toUnsignedInt(rgba.get(i)) << 16)
                    | (Byte.toUnsignedInt(rgba.get(i + 1)) << 8) | Byte.toUnsignedInt(rgba.get(i + 2));
            }
        }
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
        var writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) throw new IOException("No Java JPEG encoder");
        var writer = writers.next();
        try (var bytes = new BoundedOutput(new DigestOutputStream(
                Files.newOutputStream(output, LinkOption.NOFOLLOW_LINKS), digest));
             var stream = new MemoryCacheImageOutputStream(bytes)) {
            writer.setOutput(stream);
            var parameters = writer.getDefaultWriteParam();
            parameters.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            parameters.setCompressionQuality(.82f);
            writer.write(null, new IIOImage(image, null, null), parameters);
            stream.flush();
        } finally { writer.dispose(); }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static final class BoundedOutput extends FilterOutputStream {
        private int bytes;

        BoundedOutput(OutputStream output) { super(output); }

        @Override public void write(int value) throws IOException {
            limit(1);
            out.write(value);
        }

        @Override public void write(byte[] value, int offset, int length) throws IOException {
            limit(length);
            out.write(value, offset, length);
        }

        private void limit(int count) throws IOException {
            if (count > AgentVisualMailbox.MAX_JPEG - bytes) throw new IOException("Visual JPEG exceeded byte limit");
            bytes += count;
        }
    }
}
