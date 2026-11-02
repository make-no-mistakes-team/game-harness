package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Pure production capture-cache proof; real body/render hook conformance needs the native fixture. */
public final class ControllerRenderProof {
  private static final long MAX_AGE_NS = 5_000_000_000L;

  private static void require(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }

  private static ByteBuffer frame() {
    return ByteBuffer.allocate(NativeRenderSnapshot.HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN);
  }

  private static void sample(NativeRenderSnapshot render, long sampled, long life, long space,
      double x, double yaw, double pitch) {
    render.begin();
    render.positionMatrix[0] = 2;
    render.projectionMatrix[0] = 3;
    render.sample(sampled, life, space, x, 2.5, -3.75, 0, .5f, 0, .866f, yaw, pitch, .625);
  }

  public static void main(String[] ignored) {
    NativeRenderSnapshot render = new NativeRenderSnapshot();
    require(render.actorCapture(8, 12, 100).isJsonNull(), "unavailable capture fabricated zero camera");
    long sampled = -9007199254740997L, captured = sampled + 101;
    sample(render, sampled, 8, 12, 1.25, .2, .3);
    ByteBuffer wire = frame();
    render.header(wire, 640, 480, -1, 1234, captured, 2147483665L, 8, 12, 19, null);
    render.finished(wire, captured + 5);
    JsonObject actor = render.actorCapture(8, 12, captured + 6).getAsJsonObject();
    require(actor.size() == 8, "capture projection leaked extra diagnostic fields");
    require(actor.get("capture_sequence").getAsLong() == Integer.toUnsignedLong(wire.getInt(16))
        && actor.get("client_tick").getAsLong() == wire.getLong(56)
        && actor.get("render_invocation").getAsLong() == wire.getLong(64), "actual header identity join lost");
    require(actor.getAsJsonPrimitive("sampled_native_ns").isString()
        && actor.get("sampled_native_ns").getAsString().equals(Long.toString(wire.getLong(48)))
        && actor.getAsJsonPrimitive("capture_native_ns").isString()
        && actor.get("capture_native_ns").getAsString().equals(Long.toString(wire.getLong(32))),
        "signed unsafe monotonic values narrowed or relabelled");
    require(actor.getAsJsonObject("position").get("x").getAsDouble() == wire.getDouble(96)
        && actor.getAsJsonObject("position").get("y").getAsDouble() == wire.getDouble(104)
        && actor.getAsJsonObject("position").get("z").getAsDouble() == wire.getDouble(112)
        && actor.get("yaw_radians").getAsDouble() == wire.getDouble(136)
        && actor.get("pitch_radians").getAsDouble() == -wire.getDouble(144), "actual header camera pose join lost");
    render.end();
    sample(render, captured + 10, 8, 12, 99, 1.4, -.8);
    render.end();
    require(render.actorCapture(8, 12, captured + 20).equals(actor),
        "later uncaptured render update replaced named capture pose");
    actor.getAsJsonObject("position").addProperty("x", -999);
    require(render.actorCapture(8, 12, captured + 20).getAsJsonObject()
        .getAsJsonObject("position").get("x").getAsDouble() == 1.25, "caller mutation corrupted scalar cache");
    require(render.actorCapture(9, 12, captured + 20).isJsonNull(), "old life capture survived fence");
    require(render.actorCapture(8, 13, captured + 20).isJsonNull(), "old space capture survived fence");
    require(render.actorCapture(8, 12, captured - 1).isJsonNull(), "future capture admitted");
    require(!render.actorCapture(8, 12, captured + MAX_AGE_NS).isJsonNull(), "freshness endpoint rejected");
    require(render.actorCapture(8, 12, captured + MAX_AGE_NS + 1).isJsonNull(), "stale capture admitted");
    render.invalidate();
    require(render.actorCapture(8, 12, captured + 20).isJsonNull(), "unavailable-world invalidation retained capture");

    sample(render, 500, 8, 12, 4, .4, .5);
    render.header(wire.clear(), 640, 480, 18, 1235, 600, 15, 8, 12, 19, null);
    require(!render.actorCapture(8, 12, 601).isJsonNull(), "positive monotonic capture unavailable");
    render.end();
    render.begin();
    render.header(wire.clear(), 640, 480, 19, 1236, 700, 16, 8, 12, 19,
        new EffectAuthority.Screen("00112233-4455-6677-8899-aabbccddeeff", 5, 6));
    require(wire.getInt(312) == 2 && render.actorCapture(8, 12, 701).isJsonNull(),
        "GUI-only header reused previous world camera");
    sample(render, 800, 8, 12, 4, .4, .5);
    render.header(wire.clear(), 640, 480, 20, 1237, 799, 17, 8, 12, 19, null);
    require(render.actorCapture(8, 12, 801).isJsonNull(), "future sample produced capture metadata");
    sample(render, 9007199254740993L, 8, 12, 7, .6, -.7);
    render.header(wire.clear(), 640, 480, 21, 1238, 9007199254740995L, 18, 8, 12, 19, null);
    require(render.actorCapture(8, 12, 9007199254740996L).getAsJsonObject()
        .get("sampled_native_ns").getAsString().equals("9007199254740993"),
        "positive unsafe monotonic precision lost");
    require(render.actorCapture(8, 12, Long.MIN_VALUE).isJsonNull(), "overflowing age admitted future capture");
  }
}
