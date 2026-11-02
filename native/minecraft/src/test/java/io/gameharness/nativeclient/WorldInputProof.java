package io.gameharness.nativeclient;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** Pure ordinary-input codec and application-clock proofs, not simulated vanilla outcomes. */
public final class WorldInputProof {
  private static void require(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }
  private static JsonObject step(int ticks, String key, String edges, String view) {
    JsonObject value = JsonParser.parseString("{\"ticks\":" + ticks
        + ",\"held\":{\"forward\":false,\"back\":false,\"left\":false,\"right\":false,\"jump\":false,"
        + "\"sprint\":false,\"sneak\":false,\"attack\":false,\"use\":false},\"edges\":" + edges
        + ",\"view\":" + view + ",\"selected_hotbar\":null}").getAsJsonObject();
    if (key != null) value.getAsJsonObject("held").addProperty(key, true);
    return value;
  }
  private static JsonObject step(int ticks, String key, String edges) {
    return step(ticks, key, edges, "{\"kind\":\"unchanged\"}");
  }
  private static JsonObject clip(JsonObject... steps) {
    JsonObject value = new JsonObject(); value.addProperty("kind", "world_input");
    JsonArray list = new JsonArray(); for (JsonObject step : steps) list.add(step); value.add("steps", list);
    return value;
  }
  private static String button(String key, String phase, int count) {
    return "{\"kind\":\"button\",\"button\":\"" + key + "\",\"phase\":\"" + phase + "\",\"count\":" + count + "}";
  }
  private static void reject(JsonObject value, String reason) {
    boolean rejected = false;
    try { WorldInputPlan.decode(value); } catch (IllegalArgumentException expected) { rejected = true; }
    require(rejected, reason);
  }
  private static int presses(WorldInputPlan.Step step, int key) {
    int count = 0;
    for (int i = 0; i < step.edgeCount(); i++) {
      WorldInputPlan.Edge edge = step.edge(i);
      if (edge.kind() == WorldInputPlan.EdgeKind.BUTTON && edge.key() == key && edge.press()) count += edge.count();
    }
    return count;
  }
  public static void main(String[] ignored) {
    JsonObject ordinaryEnvelope = new JsonObject();
    ordinaryEnvelope.addProperty("operation_id", "ordinary-proof");
    ordinaryEnvelope.addProperty("compatibility_hash", "a".repeat(64));
    EffectAuthority nativeAuthority = new EffectAuthority("session", "world", 1);
    EffectAuthority.Scope nativeScope = new EffectAuthority.Scope("session", "world", 1,
        nativeAuthority.nativeBootId(), "run", 2, 3, 4, "execution", "a".repeat(64));
    ordinaryEnvelope.add("scope", NativeEffectContract.scope(nativeScope));
    ordinaryEnvelope.add("invocation", JsonParser.parseString("{\"kind\":\"diagnostic\",\"execution_id\":\"execution\",\"source_hash\":\""
        + "a".repeat(64) + "\"}"));
    ordinaryEnvelope.add("expected_screen", NativeEffectContract.precondition(EffectAuthority.ScreenPrecondition.absent()));
    ordinaryEnvelope.add("action", clip(step(1, null, "[]")));
    require(NativeEffectContract.effect(ordinaryEnvelope, 1).worldInput().totalTicks() == 1,
        "native receive codec did not decode registered world input");
    ordinaryEnvelope.add("expected_screen", NativeEffectContract.precondition(EffectAuthority.ScreenPrecondition.transaction(new EffectAuthority.Screen("visible", 1, 0))));
    boolean screenRejected = false;
    try { NativeEffectContract.effect(ordinaryEnvelope, 1); } catch (IllegalArgumentException expected) { screenRejected = true; }
    require(screenRejected, "native receive admitted a world input owner against an existing screen precondition");
    JsonObject declareOnly = step(2, null, "[]");
    declareOnly.addProperty("selected_hotbar", 0);
    JsonObject declareAndEdge = step(1, null, "[{\"kind\":\"hotbar\",\"slot\":1}]");
    declareAndEdge.addProperty("selected_hotbar", 1);
    WorldInputState selection = new WorldInputState(WorldInputPlan.decode(clip(declareOnly, declareAndEdge)), 100);
    require(selection.entrySelection() == -1, "unprepared declarative selection applied before admission");
    selection.prepare(1, 101);
    require(selection.entrySelection() == 0 && selection.appliedTicks() == 0
        && selection.step().edgeCount() == 0,
        "declarative selection was deferred to a counted vanilla hotbar edge");
    selection.consumed(1, 102); selection.settle(1, 0, 0); selection.prepare(2, 103);
    require(selection.entrySelection() == -1, "declarative selection repeated beyond step entry");
    selection.consumed(2, 104); selection.settle(2, 0, 0); selection.prepare(3, 105);
    require(selection.entrySelection() == 1 && selection.step().edge(0).slot() == 1,
        "agreeing authored hotbar edge suppressed the step-entry declaration");
    selection.stop();
    require(selection.entrySelection() == -1, "stopped owner retained a declarative selection application");
    // Removing the distinction between held state and counted presses breaks these cases.
    WorldInputPlan hold = WorldInputPlan.decode(clip(step(3, "attack", "[" + button("attack", "press", 1) + "]"),
        step(1, null, "[" + button("attack", "release", 1) + "]")));
    require(hold.step(0).held(7) && presses(hold.step(0), 7) == 1,
        "held block breaking requires one click, not one attack click per held tick");
    WorldInputPlan clicks = WorldInputPlan.decode(clip(step(1, "attack", "[" + button("attack", "press", 3) + "]")));
    require(presses(clicks.step(0), 7) == 3, "repeated entity clicks collapsed into held state");
    WorldInputState heldClock = new WorldInputState(hold, 100);
    heldClock.prepare(1, 101);
    require(heldClock.entry() && heldClock.held(7), "held attack was not applied at step entry");
    heldClock.consumed(1, 102); heldClock.settle(1, 0, 0); heldClock.prepare(2, 103);
    require(!heldClock.entry() && heldClock.held(7), "held tick manufactured another edge-entry phase");
    heldClock.stop();
    require(!heldClock.held(7), "trusted cleanup retained held input ownership");
    WorldInputPlan repeated = WorldInputPlan.decode(clip(step(1, "use", "[" + button("use", "press", 1) + "]"),
        step(1, "use", "[" + button("use", "press", 2) + "]"),
        step(1, null, "[" + button("use", "release", 1) + "]")));
    require(presses(repeated.step(1), 8) == 2 && presses(repeated.step(2), 8) == 0 && !repeated.step(2).held(8),
        "draw/shield/eating release became a press or held-use repeat lost counted semantics");
    WorldInputPlan simultaneous = WorldInputPlan.decode(clip(step(1, "use", "[" + button("use", "press", 1)
        + "," + button("attack", "press", 1) + "," + button("attack", "release", 1) + "]")));
    require(simultaneous.step(0).edge(0).key() == 8 && presses(simultaneous.step(0), 7) == 1,
        "wire injection order lost before vanilla applies attack/use precedence");
    require(presses(WorldInputPlan.decode(clip(step(1, null, "[" + button("inventory", "press", 1) + ","
        + button("inventory", "release", 1) + "]"))).step(0), 9) == 1,
        "inventory release generated a second open press");
    reject(clip(step(1, "attack", "[]")), "held transition without an edge admitted");
    reject(clip(step(1, null, "[" + button("attack", "release", 2) + "]")), "counted release admitted");
    reject(clip(step(1, null, "[{\"kind\":\"gui_text\",\"text\":\"x\"}]")), "GUI text admitted as world input");
    reject(clip(step(1, null, "[{\"kind\":\"camera_delta\",\"x\":1,\"y\":0}]")), "ambiguous second view path admitted");
    reject(clip(step(1, null, "[{\"kind\":\"drop\",\"all\":true},{\"kind\":\"drop\",\"all\":false}]")),
        "conflicting queued drop modifiers admitted");
    reject(clip(step(1, null, "[{\"kind\":\"hotbar\",\"slot\":1},{\"kind\":\"hotbar\",\"slot\":2}]")),
        "conflicting grouped hotbar events admitted");
    JsonObject mismatch = step(1, null, "[{\"kind\":\"hotbar\",\"slot\":2}]"); mismatch.addProperty("selected_hotbar", 3);
    reject(clip(mismatch), "declarative hotbar disagreed with final edge");
    JsonObject extra = step(1, null, "[]"); extra.addProperty("target", "stored-target"); reject(clip(extra), "hidden aim field admitted");
    JsonObject coercion = step(1, null, "[]"); coercion.getAsJsonObject("held").addProperty("use", "false");
    reject(clip(coercion), "string coerced to held boolean");
    reject(clip(step(100, null, "[]"), step(1, null, "[]")), "total tick bound bypassed");
    reject(clip(step(1, "attack", "[" + button("attack", "press", 256) + "," + button("attack", "press", 1) + "]")),
        "expanded edge limit bypassed");
    JsonObject sixtyFive = clip(); for (int i = 0; i < 65; i++) sixtyFive.getAsJsonArray("steps").add(step(1, null, "[]"));
    reject(sixtyFive, "step bound bypassed");
    require(WorldInputPlan.decode(clip(step(100, "attack", "[" + button("attack", "press", 256) + "]"))).totalTicks() == 100,
        "inclusive limits refused");

    WorldInputPlan view = WorldInputPlan.decode(clip(step(2, null, "[]", "{\"kind\":\"delta\",\"yaw_radians\":1,\"pitch_radians\":0.5}"),
        step(2, null, "[]", "{\"kind\":\"rate\",\"yaw_radians_per_second\":2,\"pitch_radians_per_second\":-1}")));
    WorldInputState state = new WorldInputState(view, 100);
    require(state.prepare(1, 101) && state.yawDelta() == 1 && state.pitchDelta() == .5,
        "delta missing at step entry");
    require(!state.prepare(1, 102) && state.appliedTicks() == 0, "duplicate phase or queued inputs counted applied");
    require(!state.settle(1, .2, .3), "unconsumed tick advanced action");
    state.consumed(1, 110); require(state.appliedTicks() == 1, "actual consumption was not counted");
    state.settle(1, .2, .3); require(state.prepare(2, 111) && state.yawDelta() == 0, "delta integrated again on held tick");
    state.consumed(2, 120); state.settle(2, .4, .5);
    require(state.appliedSteps() == 1 && state.prepare(3, 121) && state.yawDelta() == .1 && state.pitchDelta() == -.05,
        "rate did not use one 50ms simulation clock");
    state.consumed(3, 130); state.settle(3, .6, .7);
    state.prepare(4, 131); state.consumed(4, 140); require(state.settle(4, .8, .9) && state.completed(), "last consumed tick not settled");
    require(state.appliedSteps() == 2 && state.lastTick() == 4 && state.yaw() == .8 && state.pitch() == .9,
        "receipt fabricated requested rather than actual constrained pose");
    require(state.firstNanos() == 110 && state.lastNanos() == 140, "enqueue time misreported as consumption time");
    state.stop(); require(!state.prepare(5, 141), "cleanup replayed a stopped clip");
    WorldInputState stoppedBeforeConsumption = new WorldInputState(clicks, 100);
    stoppedBeforeConsumption.prepare(7, 101);
    stoppedBeforeConsumption.injected(3);
    stoppedBeforeConsumption.stop();
    stoppedBeforeConsumption.consumed(7, 102);
    require(stoppedBeforeConsumption.appliedTicks() == 0 && stoppedBeforeConsumption.edgePrefix() == 3,
        "cancellation confused an injected edge prefix with actual consumption");
    WorldInputState repeatedConsumption = new WorldInputState(clicks, 100);
    repeatedConsumption.prepare(7, 101);
    repeatedConsumption.consumed(7, 102); repeatedConsumption.consumed(7, 103);
    require(repeatedConsumption.appliedTicks() == 1 && repeatedConsumption.lastNanos() == 102,
        "duplicate consume callback fabricated a second native tick");
    WorldInputPlan immutable = WorldInputPlan.decode(clip(step(1, null, "[]")));
    WorldInputState openedAtEnd = new WorldInputState(WorldInputPlan.decode(clip(step(1, null,
        "[" + button("inventory", "press", 1) + "]"))), 100);
    openedAtEnd.prepare(1, 101); openedAtEnd.injected(1);
    require(!openedAtEnd.applicationConfirmed("screen_opened"), "queued open was called consumed");
    openedAtEnd.consumed(1, 102); openedAtEnd.settle(1, 0, 0);
    require(openedAtEnd.applicationConfirmed("screen_opened"), "fully consumed single-step open cannot continue to visible GUI");
    require(openedAtEnd.applicationStatus("screen_opened", false).equals("succeeded"), "completed local inventory opening was called a world mutation failure");
    require(!openedAtEnd.applicationConfirmed("cancelled"), "cancelled ownership became confirmed from a screen");
    WorldInputState openedWithRemainder = new WorldInputState(WorldInputPlan.decode(clip(step(1, null,
        "[" + button("inventory", "press", 1) + "]"), step(1, null, "[]"))), 100);
    openedWithRemainder.prepare(1, 101); openedWithRemainder.injected(1);
    openedWithRemainder.consumed(1, 102); openedWithRemainder.settle(1, 0, 0);
    require(!openedWithRemainder.applicationConfirmed("screen_opened") && openedWithRemainder.appliedSteps() == 1,
        "opening screen fabricated consumption of the remaining step");
    require(openedWithRemainder.applicationStatus("screen_opened", false).equals("unknown"),
        "partially consumed local inventory opening lost uncertainty without an outgoing gameplay packet");
    JsonObject mutableSource = clip(step(1, null, "[]"));
    WorldInputPlan decoded = WorldInputPlan.decode(mutableSource);
    mutableSource.getAsJsonArray("steps").get(0).getAsJsonObject().getAsJsonObject("held").addProperty("attack", true);
    require(!decoded.step(0).held(7) && !immutable.step(0).held(7), "capture JSON mutation changed an admitted input plan");
    WorldInputState expired = new WorldInputState(hold, 100);
    require(!expired.expired(100 + 2_200_000_000L - 1) && expired.expired(100 + 2_200_000_000L),
        "finite native receive-age wall bound changed");
    reject(clip(step(1, null, "[]", "{\"kind\":\"delta\",\"yaw_radians\":7,\"pitch_radians\":0}")), "view delta exceeded 2pi");
    reject(clip(step(1, null, "[]", "{\"kind\":\"rate\",\"yaw_radians_per_second\":63,\"pitch_radians_per_second\":0}")), "view rate exceeded 20pi");
  }
}
