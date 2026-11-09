package io.gameharness.nativeclient;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** Counted and sampled observations earn expanded prefix credit, never one credit per edge object. */
public final class InputConsumptionProof {
  private static void require(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
  private static WorldInputPlan.Step step(int held, String edges) {
    String[] keys = {"forward", "back", "left", "right", "jump", "sprint", "sneak", "attack", "use"};
    JsonObject value = JsonParser.parseString("{\"kind\":\"world\",\"held\":{},\"edges\":" + edges
        + ",\"view\":{\"kind\":\"unchanged\"},\"selected_hotbar\":null}").getAsJsonObject();
    for (int index = 0; index < keys.length; index++) value.getAsJsonObject("held").addProperty(keys[index], (held & (1 << index)) != 0);
    return WorldInputPlan.streamStep(value, 0);
  }
  private static String press(String button, int count) {
    return "{\"kind\":\"button\",\"button\":\"" + button + "\",\"phase\":\"press\",\"count\":" + count + "}";
  }
  public static void main(String[] ignored) {
    var consumption = new InputConsumption();
    consumption.reset(step(1, "[" + press("forward", 1) + "," + press("forward", 1) + "]"));
    consumption.sampled(1); consumption.releasesConsumed();
    require(consumption.prefix(10) == 11, "one movement sample confirmed two split presses");
    consumption.sampled(1);
    require(consumption.prefix(10) == 11, "repeated observation of one held level invented another press");
    consumption.reset(step(1, "[" + press("forward", 2) + "]"));
    consumption.sampled(1); consumption.releasesConsumed();
    require(consumption.prefix(10) == 11, "counted and split movement representations disagree");
    consumption.counted(0);
    require(consumption.prefix(10) == 11, "sample and first counted read double-credited the same movement press");
    consumption.counted(0);
    require(consumption.prefix(10) == 12, "second distinct counted observation lost its press");
    consumption.reset(step(1, "[" + press("forward", 2) + "]"));
    consumption.counted(0); consumption.sampled(1);
    require(consumption.prefix(0) == 1, "counted read followed by a level sample duplicated its observation");

    consumption.reset(step(1, "[" + press("forward", 1)
        + ",{\"kind\":\"button\",\"button\":\"forward\",\"phase\":\"release\",\"count\":1}," + press("forward", 1) + "]"));
    consumption.sampled(1); consumption.releasesConsumed();
    require(consumption.prefix(0) == 2, "one sample confirmed repeated movement through a release/repress");
    consumption.reset(step(9, "[" + press("forward", 1) + "," + press("right", 1) + "]"));
    consumption.sampled(9); consumption.releasesConsumed();
    require(consumption.prefix(0) == 2, "independent simultaneous movement buttons lost their actual sample credit");

    consumption.reset(step(0, "[" + press("inventory", 3) + "]"));
    consumption.counted(9); consumption.releasesConsumed();
    require(consumption.prefix(4) == 5, "partially consumed inventory count lost its first actual press");
    consumption.reset(step(128, "[" + press("attack", 2) + "," + press("inventory", 3) + "]"));
    consumption.counted(7); consumption.counted(7); consumption.counted(9);
    require(consumption.prefix(0) == 3, "full prior edge plus partial counted edge lost expanded prefix");
    consumption.reset(step(384, "[" + press("use", 3) + "," + press("attack", 2) + "]"));
    require(consumption.nextOrdinal(7, 20) == 24, "attack callback lost its original ordered edge identity");
    consumption.counted(7);
    require(consumption.nextOrdinal(7, 20) == 25, "counted attack callbacks shared one edge ordinal");
    consumption.reset(step(384, "[" + press("use", 3) + "," + press("attack", 2) + "]"));
    consumption.counted(7); consumption.counted(7);
    require(consumption.prefix(0) == 0, "later consumed presses jumped an earlier unresolved ordered suffix");
    consumption.counted(8);
    require(consumption.prefix(0) == 1, "partial earlier edge incorrectly included later already consumed work");
    consumption.counted(8); consumption.counted(8);
    require(consumption.prefix(0) == 5, "complete contiguous counted observations were not credited");
    System.out.println("Native expanded input consumption proof passed");
  }
}
