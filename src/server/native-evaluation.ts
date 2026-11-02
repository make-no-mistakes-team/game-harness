import { z } from "zod";

/** Trusted, default-off evaluator configuration; never an actor connection field. */
export interface NativeEvaluationOptions {
  version: 1;
  allow_inventory_replacement: boolean;
  control_send_buffer_bytes: number | null;
}

const nativeEvaluationSchema = z.object({
  version: z.literal(1),
  allow_inventory_replacement: z.boolean(),
  control_send_buffer_bytes: z.number().int().min(4096).max(16384).nullable(),
}).strict().refine(value => value.allow_inventory_replacement || value.control_send_buffer_bytes !== null,
  "Native evaluation must select at least one facility");

/** Null is the only disabled wire form; constructor omission is normalized by its caller. */
export function normalizeNativeEvaluation(input: unknown, allowEvaluation: boolean): Readonly<NativeEvaluationOptions> | null {
  if (input === null) return null;
  if (!allowEvaluation) throw new Error("Native evaluation requires GAMEHARNESS_NATIVE_PROOF=1");
  return Object.freeze(nativeEvaluationSchema.parse(input));
}
