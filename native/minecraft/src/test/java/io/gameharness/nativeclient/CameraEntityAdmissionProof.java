package io.gameharness.nativeclient;

import java.util.ArrayList;

/** Pure production geometry/witness proof, not a claim of live hook or gameplay conformance. */
public final class CameraEntityAdmissionProof {
  private static final long NOW = -9_007_199_254_740_993L;
  private static final EffectAuthority.Space SPACE = new EffectAuthority.Space("minecraft:overworld", 7);
  private static final String WALL = "2026-11-09T12:00:00.000Z";

  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  private static float[] identity() {
    float[] matrix = new float[16];
    matrix[0] = matrix[5] = matrix[10] = matrix[15] = 1;
    return matrix;
  }

  private static float[] perspective(double verticalFov, double aspect, double zoom) {
    float[] matrix = new float[16];
    double scale = zoom / Math.tan(verticalFov / 2);
    matrix[0] = (float) (scale / aspect); matrix[5] = (float) scale;
    matrix[10] = -101f / 99f; matrix[11] = -1; matrix[14] = -200f / 99f;
    return matrix;
  }

  private static void geometry() {
    float[] view = identity(), projection = perspective(Math.PI / 2, 1, 1);
    require(RenderedEntityAdmission.inViewport(view, projection, 0, 0, -4), "front was denied");
    require(!RenderedEntityAdmission.inViewport(view, projection, 0, 0, 4), "behind was admitted");
    for (double x : new double[] {-.3, .3})
      for (double y : new double[] {-1, 1})
        for (double z : new double[] {3.7, 4.3})
          require(!RenderedEntityAdmission.inViewport(view, projection, x, y, z),
              "an all-behind-camera zombie box corner was admitted");
    float[] modelView = identity();
    modelView[12] = .5f; modelView[13] = .25f; modelView[14] = -4;
    require(RenderedEntityAdmission.inViewport(modelView, projection, 0, 0, 0),
        "actual dispatcher model-view translation was ignored");
    modelView[12] = 4.01f;
    require(!RenderedEntityAdmission.inViewport(modelView, projection, 0, 0, 0),
        "actual renderer offset beyond the viewport was ignored");
    float[] cameraView = identity(), dispatcherModel = identity();
    cameraView[0] = cameraView[10] = -1; // Minecraft yaw zero looks toward world +Z.
    dispatcherModel[13] = -1.62f; dispatcherModel[14] = 4;
    require(RenderedEntityAdmission.inViewport(cameraView, dispatcherModel, projection, 0, .975, 0),
        "visible Minecraft +Z entity was rejected by omitting the separate camera matrix");
    require(!RenderedEntityAdmission.inViewport(identity(), dispatcherModel, projection, 0, .975, 0),
        "same dispatcher placement became visible after the actual camera turned away");
    dispatcherModel[12] = 4.01f;
    require(!RenderedEntityAdmission.inViewport(cameraView, dispatcherModel, projection, 0, .975, 0),
        "composed camera/model projection ignored the real viewport boundary");
    require(RenderedEntityAdmission.inViewport(view, projection, 4, 4, -4), "viewport endpoint was denied");
    require(!RenderedEntityAdmission.inViewport(view, projection, 4.001, 0, -4)
        && !RenderedEntityAdmission.inViewport(view, projection, 0, 4.001, -4),
        "horizontal/vertical clip boundary was ignored");
    require(!RenderedEntityAdmission.inViewport(view, projection, 0, 0, -.99)
        && !RenderedEntityAdmission.inViewport(view, projection, 0, 0, -100.01),
        "near/far clip planes were ignored");
    require(RenderedEntityAdmission.inViewport(view, perspective(Math.PI / 2, 2, 1), 6, 0, -4)
        && !RenderedEntityAdmission.inViewport(view, perspective(Math.PI / 2, .5, 1), 3, 0, -4),
        "actual viewport aspect was ignored");
    require(!RenderedEntityAdmission.inViewport(view, perspective(Math.PI / 3, 1, 1), 3, 0, -4)
        && RenderedEntityAdmission.inViewport(view, perspective(2 * Math.PI / 3, 1, 1), 5, 0, -4),
        "actual FOV was replaced with a fixed cone");
    require(!RenderedEntityAdmission.inViewport(view, perspective(Math.PI / 2, 1, 2), 3, 0, -4),
        "zoom projection was ignored");
    // Same world-relative point, opposite rendered camera; player yaw is intentionally absent.
    view[0] = view[10] = -1;
    require(!RenderedEntityAdmission.inViewport(view, projection, 0, 0, -4)
        && RenderedEntityAdmission.inViewport(view, projection, 0, 0, 4), "camera turned away retained front admission");
    require(!RenderedEntityAdmission.inViewport(view, projection, Double.NaN, 0, -4),
        "nonfinite world point was admitted");
    projection[0] = Float.NaN;
    require(!RenderedEntityAdmission.inViewport(view, projection, 0, 0, -4), "invalid projection was admitted");
    require(!RenderedEntityAdmission.inViewport(new float[16], new float[16], 0, 0, -4),
        "missing matrices were admitted");
  }

  private static void witnesses() {
    var gate = new RenderedEntityAdmission<Object, String>(32);
    Object seen = new Object(), spawnedLater = new Object();
    require(gate.get(seen, 11, 3, SPACE, NOW) == null, "missing render admitted an entity");
    gate.begin(11, NOW, WALL, 90, 3, SPACE);
    require(gate.candidate(), "first render candidate denied");
    gate.rendered(seen, "original-rendered-pose");
    require(gate.get(seen, 11, 3, SPACE, NOW) == null, "unfinished render acquired a handle");
    gate.endWorld();
    require(gate.get(seen, 11, 3, SPACE, NOW) == null, "render without framebuffer readback acquired a handle");
    gate.captured(11, 42, 3, SPACE);
    require("original-rendered-pose".equals(gate.get(seen, 11, 3, SPACE, NOW + 1)),
        "same-render observed target was unavailable");
    // A new world entity may project into the old frame but has no render witness in it.
    require(RenderedEntityAdmission.inViewport(identity(), perspective(Math.PI / 2, 1, 1), 0, 0, -4)
        && gate.get(spawnedLater, 11, 3, SPACE, NOW + 1) == null,
        "entity appearing after capture inherited the old camera witness");
    gate.rendered(spawnedLater, "post-capture-live-position");
    require(gate.get(spawnedLater, 11, 3, SPACE, NOW + 2) == null, "late world/GUI render entered a sealed capture");
    require("original-rendered-pose".equals(gate.get(seen, 11, 3, SPACE, NOW + 2))
        && gate.sampled() == NOW && gate.wallTime().equals(WALL) && gate.tick() == 90
        && gate.invocation() == 11 && gate.captureSequence() == 42,
        "retained witness acquired live motion or relabelled original capture identity/time");
    require(gate.get(seen, 11, 3, SPACE, NOW + 250_000_000L) != null
        && gate.get(seen, 11, 3, SPACE, NOW + 250_000_001L) == null,
        "250ms render age boundary was not exact");
    require(gate.get(seen, 11, 3, SPACE, NOW - 1) == null
        && gate.get(seen, 12, 3, SPACE, NOW + 1) == null
        && gate.get(seen, 11, 4, SPACE, NOW + 1) == null
        && gate.get(seen, 11, 3, new EffectAuthority.Space("minecraft:overworld", 8), NOW + 1) == null
        && gate.get(seen, 11, 3, new EffectAuthority.Space("minecraft:the_nether", 7), NOW + 1) == null,
        "future/mismatched render, life or space retained a handle");
    // The turned-away render has no seen entity: old identities/positions/counts disappear,
    // but the caller may retain the previously returned string as honest historical memory.
    gate.begin(12, NOW + 3, WALL, 91, 3, SPACE);
    require(gate.get(seen, 12, 3, SPACE, NOW + 3) == null, "new render retained old target custody");
    require("original-rendered-pose".equals(gate.get(seen, 11, 3, SPACE, NOW + 3)),
        "an unfinished render erased the last completed framebuffer's evidence");
    gate.endWorld(); gate.captured(12, 43, 3, SPACE);
    var rows = new ArrayList<String>();
    gate.forEach(12, 3, SPACE, NOW + 4, (key, value) -> rows.add(value));
    require(rows.isEmpty() && gate.get(seen, 12, 3, SPACE, NOW + 4) == null,
        "offscreen loss retained a handle, count or live motion");
    gate.begin(13, NOW + 5, WALL, 92, 3, SPACE); gate.rendered(seen, "render13"); gate.endWorld();
    gate.captured(12, 44, 3, SPACE);
    require(gate.get(seen, 13, 3, SPACE, NOW + 6) == null, "different framebuffer invocation admitted a handle");
    gate.begin(14, NOW + 7, WALL, 93, 3, SPACE); gate.rendered(seen, "render14");
    gate.captured(14, 45, 3, SPACE);
    require(gate.get(seen, 14, 3, SPACE, NOW + 8) == null, "uncompleted world render admitted a handle");
    gate.invalidate();
    gate.captured(14, 45, 3, SPACE);
    require(gate.get(seen, 14, 3, SPACE, NOW + 8) == null, "scope invalidation retained a target");
    gate.begin(15, NOW + 9, WALL, 94, 3, SPACE);
    for (int i = 0; i < 128; i++) require(gate.candidate(), "private candidate quota ended early");
    require(!gate.candidate(), "private render candidate bound exceeded");
    gate.endWorld(); gate.captured(15, 46, 3, SPACE);
    require(!gate.candidate(), "sealed render accepted another candidate");
    gate.begin(16, NOW + 10, WALL, 95, 3, SPACE);
    for (int i = 0; i < 40; i++) {
      if (gate.candidate()) gate.rendered(new Object(), "bounded-row");
    }
    gate.endWorld(); gate.captured(16, 47, 3, SPACE);
    rows.clear(); gate.forEach(16, 3, SPACE, NOW + 11, (key, value) -> rows.add(value));
    require(rows.size() == 32, "render witness retention exceeded its public row bound");
    rows.clear(); gate.forEach(16, 4, SPACE, NOW + 11, (key, value) -> rows.add(value));
    require(rows.isEmpty(), "wrong-scope bulk read exposed entity counts or poses");
    gate.begin(17, NOW + 11, WALL, 96, 3, SPACE); gate.rendered(seen, "wrong-life"); gate.endWorld();
    gate.captured(17, 48, 4, SPACE);
    require(gate.get(seen, 17, 4, SPACE, NOW + 12) == null, "readback from another life admitted a target");
    gate.begin(18, NOW + 13, WALL, 97, 3, SPACE); gate.rendered(seen, "wrong-space"); gate.endWorld();
    gate.captured(18, 49, 3, new EffectAuthority.Space("minecraft:the_nether", 7));
    require(gate.get(seen, 18, 3, SPACE, NOW + 14) == null, "readback from another dimension admitted a target");
    gate.begin(19, NOW + 15, WALL, 98, 3, null);
    require(!gate.candidate(), "missing authoritative space admitted a render candidate");
    gate.endWorld(); gate.captured(19, 50, 3, null);
    require(!gate.current(19, 3, null, NOW + 16), "missing authoritative space acquired a capture witness");
  }

  private static void skippedReadbacks() {
    var gate = new RenderedEntityAdmission<Object, String>(32);
    Object seen = new Object(), unseen = new Object();
    gate.begin(21, NOW, WALL, 101, 3, SPACE);
    gate.rendered(seen, "captured-pose"); gate.endWorld(); gate.captured(21, 51, 3, SPACE);
    gate.begin(22, NOW + 10_000_000L, WALL, 102, 3, SPACE);
    gate.rendered(seen, "uncaptured-live-motion"); gate.rendered(unseen, "uncaptured-new-spawn");
    gate.endWorld(); // Video's ordinary throttle skips readback for this render.
    require("captured-pose".equals(gate.get(seen, 21, 3, SPACE, NOW + 20_000_000L))
        && gate.get(unseen, 21, 3, SPACE, NOW + 20_000_000L) == null
        && gate.sampled() == NOW && gate.captureSequence() == 51,
        "skipped readback erased or refreshed old evidence, or disclosed uncaptured motion/spawn");
    gate.begin(23, NOW + 30_000_000L, WALL, 103, 3, SPACE);
    gate.rendered(seen, "next-captured-pose"); gate.endWorld(); gate.captured(23, 52, 3, SPACE);
    require("next-captured-pose".equals(gate.get(seen, 23, 3, SPACE, NOW + 31_000_000L))
        && gate.get(seen, 21, 3, SPACE, NOW + 31_000_000L) == null,
        "successful next capture did not atomically replace the old image's evidence");
    gate.begin(24, NOW + 40_000_000L, WALL, 104, 3, SPACE);
    gate.endWorld(); gate.captured(24, 53, 3, SPACE); // Actual turned-away captured image.
    require(gate.get(seen, 24, 3, SPACE, NOW + 41_000_000L) == null,
        "turning away in the next completed image retained a live target");
  }

  public static void main(String[] ignored) {
    geometry(); witnesses(); skippedReadbacks();
    SoundProjectionProof.main(ignored);
    System.out.println("Camera entity admission proof PASS: actual matrix clip/FOV/aspect/zoom, "
        + "same completed capture, bounded original-time render witnesses, no later-spawn admission, "
        + "offscreen handle/pose loss, life/space/age fencing; independent heard-sound proof unchanged.");
  }
}
