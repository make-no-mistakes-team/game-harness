package io.gameharness.nativeclient;

import java.util.List;
import java.util.regex.Pattern;

/** Ordered model choices; only an exact server receipt can advance to the next stage. */
public final class CraftSequence {
  private static final Pattern ITEM = Pattern.compile("[a-z][a-z0-9_]{0,79}");
  public record Stage(String item, int executions) {
    public Stage {
      if (item == null || !ITEM.matcher(item).matches() || executions < 1 || executions > 16)
        throw new IllegalArgumentException("Invalid craft stage");
    }
  }
  private final List<Stage> stages;
  private final int[] completed, confirmed, outputs;
  private int index;
  private boolean stopped;

  public CraftSequence(List<Stage> stages) {
    if (stages.isEmpty() || stages.size() > 8)
      throw new IllegalArgumentException("Craft sequence requires 1..8 stages");
    int total = 0;
    for (Stage stage : stages) total += stage.executions();
    if (total > 16) throw new IllegalArgumentException("Craft sequence exceeds 16 recipe executions");
    this.stages = List.copyOf(stages);
    completed = new int[stages.size()]; confirmed = new int[stages.size()]; outputs = new int[stages.size()];
  }
  public List<Stage> stages() { return stages; }
  public int index() { return index; }
  public Stage current() { requireActive(); return stages.get(index); }
  public int completed(int stage) { return completed[stage]; }
  public int confirmed(int stage) { return confirmed[stage]; }
  public int outputCount(int stage) { return outputs[stage]; }
  public boolean complete() { return !stopped && index == stages.size(); }
  public boolean stopped() { return stopped; }
  public void setOutputCount(int count) {
    requireActive();
    if (count < 1 || count > 64 || outputs[index] != 0) throw new IllegalStateException("Invalid recipe output count");
    outputs[index] = count;
  }
  public void deposited() {
    requireActive();
    if (outputs[index] == 0 || completed[index] == current().executions())
      throw new IllegalStateException("Output exceeds requested executions");
    completed[index]++;
  }
  /** A partial receipt retains actual production, but never admits another stage. */
  public boolean confirm(int actualGain, boolean cleanCustody) {
    requireActive();
    int output = outputs[index];
    boolean exact = cleanCustody && output > 0 && actualGain >= 0 && actualGain % output == 0
        && actualGain == completed[index] * output;
    if (exact) confirmed[index] = completed[index];
    if (!exact || confirmed[index] != current().executions()) { stopped = true; return false; }
    index++;
    return true;
  }
  public void stop() { stopped = true; }
  private void requireActive() {
    if (stopped || index >= stages.size()) throw new IllegalStateException("Craft sequence no longer active");
  }
}
