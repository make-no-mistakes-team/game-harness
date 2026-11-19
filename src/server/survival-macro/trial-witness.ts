import { createHash } from "node:crypto";
import { z } from "zod";
import type { MacroIntent, MacroReceipt } from "./protocol.ts";

const targetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("position"), x: z.number(), y: z.number(), z: z.number() }),
  z.strictObject({ kind: z.literal("camera"), yaw: z.number(), pitch: z.number().min(-90).max(90) }),
]);
const witnessSchema = z.strictObject({
  v: z.literal(1), run: z.string(), life: z.int().positive(), epoch: z.int().nonnegative(),
  basisTick: z.int().nonnegative(), intentId: z.string(), opportunityId: z.string(),
  verb: z.enum(["approach", "inspect", "survey"]), acceptedTick: z.int().nonnegative(), target: targetSchema,
});

export type MacroTrialTarget = Readonly<z.infer<typeof targetSchema>>;
export type MacroTrialWitness = Readonly<Omit<z.infer<typeof witnessSchema>, "target"> & { target: MacroTrialTarget }>;

/** The target never enters a model or skill projection. Only the owning evaluator reads it. */
export function verifyMacroTrialWitness(value: unknown, intent: MacroIntent, verb: string,
    accepted: MacroReceipt, terminal: MacroReceipt): MacroTrialWitness {
  const witness = witnessSchema.parse(value);
  if (witness.run !== intent.run || witness.life !== intent.life || witness.epoch !== intent.epoch ||
      witness.basisTick !== intent.basisTick || witness.intentId !== intent.id ||
      witness.opportunityId !== intent.opportunityId || witness.verb !== verb ||
      (witness.verb === "approach") !== (witness.target.kind === "position") ||
      accepted.status !== "accepted" || terminal.status !== "completed" ||
      accepted.id !== intent.id || terminal.id !== intent.id || accepted.run !== intent.run ||
      terminal.run !== intent.run || accepted.life !== intent.life || terminal.life !== intent.life ||
      witness.acceptedTick !== accepted.tick || accepted.tick < intent.basisTick ||
      accepted.tick >= terminal.tick || terminal.tick > intent.expiresTick)
    throw new Error("Native target witness does not match the issued intent and receipt window.");
  return Object.freeze({ ...witness, target: Object.freeze(witness.target) });
}

export function macroTrialWitnessDigest(witness: MacroTrialWitness): string {
  const t = witness.target;
  return createHash("sha256").update(JSON.stringify([
    witness.v, witness.run, witness.life, witness.epoch, witness.basisTick,
    witness.intentId, witness.opportunityId, witness.verb, witness.acceptedTick,
    t.kind === "position" ? [t.kind, t.x, t.y, t.z] : [t.kind, t.yaw, t.pitch],
  ])).digest("hex");
}

export type MacroTrialMotion = Readonly<{
  tick: number; x: number; y: number; z: number; yaw: number; pitch: number;
}>;

export function macroTrialDistance(a: Pick<MacroTrialMotion, "x" | "y" | "z">,
    b: Pick<MacroTrialMotion, "x" | "y" | "z">) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function yawDifference(a: number, b: number) {
  return (((b - a + 180) % 360) + 360) % 360 - 180;
}

export function macroTrialTurn(a: Pick<MacroTrialMotion, "yaw" | "pitch">,
    b: Pick<MacroTrialMotion, "yaw" | "pitch">) {
  return Math.hypot(yawDifference(a.yaw, b.yaw), b.pitch - a.pitch);
}

const READER_MOTION = 0.12;
const LANDING_TOLERANCE = 0.37;
export const MACRO_TRIAL_SETTLE_TICKS = 20;

export function macroTrialAtTarget(sample: MacroTrialMotion, target: MacroTrialTarget) {
  if (target.kind === "position") return macroTrialDistance(sample, target) <= LANDING_TOLERANCE;
  return Math.abs(yawDifference(sample.yaw, target.yaw)) <= 4.25 && Math.abs(sample.pitch - target.pitch) <= 4.25;
}

/** Fixed diagnostic scene: verify the targeted action itself, not just accumulated motion. */
export function verifyMacroTrialMotion(witness: MacroTrialWitness, receiptTick: number,
    before: MacroTrialMotion, settled: MacroTrialMotion, samples: readonly MacroTrialMotion[]) {
  const { target, acceptedTick } = witness;
  const acceptance = samples.find(sample => sample.tick === acceptedTick);
  const completion = samples.find(sample => sample.tick === receiptTick);
  if (!acceptance || !completion || acceptedTick >= receiptTick ||
      samples.length !== settled.tick - before.tick + 1 ||
      samples.some((sample, index) => sample.tick !== before.tick + index) ||
      settled.tick < receiptTick + MACRO_TRIAL_SETTLE_TICKS || before.tick > witness.basisTick ||
      macroTrialDistance(settled, samples.at(-1)!) > 0.03 || macroTrialTurn(settled, samples.at(-1)!) > 1)
    throw new Error("Missing exact acceptance, completion or continuous settlement measurements.");

  for (const sample of samples) {
    if (sample.tick >= acceptedTick) break;
    if (macroTrialDistance(before, sample) > 0.06 || macroTrialTurn(before, sample) > 2)
      throw new Error("Physical motion began before the native intent was accepted.");
  }
  if (macroTrialDistance(before, acceptance) > 0.12 || macroTrialTurn(before, acceptance) > 5.5)
    throw new Error("The accepted action did not start from the neutral witnessed stance.");

  if (target.kind === "position") {
    const dx = target.x - before.x, dz = target.z - before.z;
    const axial = Math.max(Math.abs(dx), Math.abs(dz));
    const lateral = Math.min(Math.abs(dx), Math.abs(dz));
    if (Math.abs(axial - 1) > 0.15 || lateral > 0.15 || Math.abs(target.y - before.y) > 0.05 ||
        !macroTrialAtTarget(completion, target) || macroTrialDistance(before, completion) < 0.45)
      throw new Error("The actor did not reach the exact witnessed adjacent tile by completion.");
    const length = Math.hypot(dx, dz);
    for (const sample of samples) {
      if (sample.tick < acceptedTick) continue;
      const x = sample.x - before.x, z = sample.z - before.z;
      const advance = (x * dx + z * dz) / length;
      const across = (x * dz - z * dx) / length;
      if (advance < -0.12 || advance > length + LANDING_TOLERANCE || Math.abs(across) > 0.26 ||
          (sample.tick >= receiptTick && !macroTrialAtTarget(sample, target)))
        throw new Error("The walk left the witnessed direction or did not settle on its target.");
    }
  } else {
    const targetTurn = macroTrialTurn(before, target);
    const completedTurn = macroTrialTurn(before, completion);
    if (targetTurn < 4 || targetTurn > 95 || completedTurn < (witness.verb === "survey" ? 4.75 : 3.75) ||
        !macroTrialAtTarget(completion, target) ||
        macroTrialTurn(completion, target) >= targetTurn - 1)
      throw new Error("The camera did not turn to the exact witnessed angle by completion.");
    const dx = yawDifference(before.yaw, target.yaw), dy = target.pitch - before.pitch;
    for (const sample of samples) {
      if (sample.tick < acceptedTick) continue;
      const yaw = yawDifference(before.yaw, sample.yaw), pitch = sample.pitch - before.pitch;
      if (macroTrialDistance(before, sample) > READER_MOTION || (yaw * dx + pitch * dy) / targetTurn < -6 ||
          (sample.tick >= receiptTick && !macroTrialAtTarget(sample, target)))
        throw new Error("The camera moved away from its witnessed direction or did not settle on it.");
    }
  }
  return { movement: macroTrialDistance(before, settled), turn: macroTrialTurn(before, settled) };
}
