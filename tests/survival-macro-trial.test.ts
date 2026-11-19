import { expect, test } from "bun:test";
import type { MacroIntent, MacroReceipt } from "../src/server/survival-macro/protocol.ts";
import {
  macroTrialWitnessDigest, verifyMacroTrialMotion, verifyMacroTrialWitness,
  type MacroTrialMotion, type MacroTrialWitness,
} from "../src/server/survival-macro/trial-witness.ts";

const intent: MacroIntent = {
  v: 1, id: "intent-31", run: "prepared-trial", life: 1, epoch: 4, basisTick: 50,
  expiresTick: 80, opportunityId: "offered-10", skillHash: "a".repeat(64),
};
const accepted: MacroReceipt = {
  v: 1, id: intent.id, run: intent.run, life: intent.life, tick: 52, status: "accepted", detail: "accepted",
};
const completed: MacroReceipt = { ...accepted, tick: 58, status: "completed", detail: "completed" };
const walk: MacroTrialWitness = {
  v: 1, run: intent.run, life: intent.life, epoch: intent.epoch, basisTick: intent.basisTick,
  intentId: intent.id, opportunityId: intent.opportunityId, verb: "approach", acceptedTick: accepted.tick,
  target: { kind: "position", x: 0.5, y: 64, z: 1.5 },
};
const survey: MacroTrialWitness = { ...walk, verb: "survey", target: { kind: "camera", yaw: -175, pitch: 36 } };

function motion(project: (progress: number, tick: number) => Partial<MacroTrialMotion>) {
  const samples = Array.from({ length: 32 }, (_, index): MacroTrialMotion => {
    const tick = index + 48;
    const progress = Math.max(0, Math.min(1, (tick - 52) / 6));
    return { tick, x: 0.5, y: 64, z: 0.5, yaw: 170, pitch: 30, ...project(progress, tick) };
  });
  return { before: samples[0]!, settled: samples.at(-1)!, samples };
}

test("a one-block walk must follow the witnessed direction and end on the selected tile", () => {
  const exact = verifyMacroTrialWitness(walk, intent, "approach", accepted, completed);
  const forward = motion(progress => ({ z: 0.5 + progress }));
  expect(verifyMacroTrialMotion(exact, completed.tick, forward.before, forward.settled, forward.samples))
    .toEqual({ movement: 1, turn: 0 });
  for (const otherDirection of [
    motion(progress => ({ z: 0.5 - progress })),
    motion(progress => ({ x: 0.5 + progress })),
  ]) {
    expect(() => verifyMacroTrialMotion(exact, completed.tick,
      otherDirection.before, otherDirection.settled, otherDirection.samples)).toThrow("exact witnessed adjacent tile");
  }
});

test("a reader must turn to the selected angle by completion and hold it through settlement", () => {
  const exact = verifyMacroTrialWitness(survey, intent, "survey", accepted, completed);
  const correct = motion(progress => ({ yaw: 170 + progress * 15, pitch: 30 + progress * 6 }));
  expect(verifyMacroTrialMotion(exact, completed.tick, correct.before, correct.settled, correct.samples).turn)
    .toBeCloseTo(Math.hypot(15, 6));
  const wrong = motion(progress => ({ yaw: 170 - progress * 15, pitch: 30 + progress * 6 }));
  expect(() => verifyMacroTrialMotion(exact, completed.tick, wrong.before, wrong.settled, wrong.samples))
    .toThrow("exact witnessed angle");
  const earlyCompletion = { ...completed, tick: 54 };
  expect(() => verifyMacroTrialMotion(exact, earlyCompletion.tick, correct.before, correct.settled, correct.samples))
    .toThrow("exact witnessed angle");
  const drift = motion((progress, tick) => ({ yaw: tick === 68 ? 170 : 170 + progress * 15, pitch: 30 + progress * 6 }));
  expect(() => verifyMacroTrialMotion(exact, completed.tick, drift.before, drift.settled, drift.samples))
    .toThrow("did not settle");
});

test("trial witness rejects stale scope, token, receipt, or wrong target kind", () => {
  verifyMacroTrialWitness(survey, intent, "survey", accepted, completed);
  for (const change of [
    { run: "other-run" }, { life: 2 }, { epoch: intent.epoch - 1 }, { basisTick: intent.basisTick - 1 },
    { acceptedTick: accepted.tick + 1 }, { opportunityId: "other-offer" }, { intentId: "other-intent" },
    { target: walk.target },
  ]) {
    expect(() => verifyMacroTrialWitness({ ...survey, ...change }, intent, "survey", accepted, completed))
      .toThrow("does not match");
  }
  expect(() => verifyMacroTrialWitness(survey, intent, "survey", accepted, { ...completed, tick: 81 }))
    .toThrow("does not match");
  expect(macroTrialWitnessDigest(survey)).not.toBe(macroTrialWitnessDigest({
    ...survey, target: { kind: "camera", yaw: 175, pitch: 36 },
  }));
});
