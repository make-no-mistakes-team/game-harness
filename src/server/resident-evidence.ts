import { z } from "zod";
import type { RuntimeAdapter } from "../shared/contracts.ts";
import type { SkillExecutionView } from "../shared/programs.ts";
import { effectScopeSchema, identitySchema, sha256Schema } from "../shared/control.ts";
import { controllerEffectUpdateSchema, controllerInputSchema, type ControllerEffectUpdate, type ControllerInput } from "../shared/controller.ts";
import { jsonSchema } from "../shared/primitives.ts";
import type { Store } from "./store.ts";

/** A real streamed input reference, not a finite ActionView or a new effect owner. */
export const residentReceiptSchema = z.object({ input_id: identitySchema, scope: effectScopeSchema,
  compatibility_hash: sha256Schema, input: controllerInputSchema, update: controllerEffectUpdateSchema }).strict();
export type ResidentReceipt = z.infer<typeof residentReceiptSchema>;

export function retainResidentReceipt(store: Store, adapter: RuntimeAdapter, execution: SkillExecutionView,
  input: ControllerInput, update: ControllerEffectUpdate) {
  if (execution.entry !== "step" || !execution.world_id || !execution.session_id || !execution.native_boot_id ||
    execution.life_id === null || execution.run_generation === null || execution.space_epoch === null ||
    !execution.source_hash || !execution.compatibility_hash)
    throw new Error("Resident receipt requires its original sealed playing execution");
  const receipt = residentReceiptSchema.parse({ input_id: `controller:${execution.execution_id}:${update.controller_generation}:${update.sequence}`,
    scope: { world_id: execution.world_id, session_id: execution.session_id, epoch: execution.epoch,
      native_boot_id: execution.native_boot_id, run_id: execution.run_id, run_generation: execution.run_generation,
      life_id: execution.life_id, space_epoch: execution.space_epoch, execution_id: execution.execution_id, source_hash: execution.source_hash },
    compatibility_hash: execution.compatibility_hash, input, update });
  const retained = store.event(execution.run_id, "controller.receipted", "Actual controller effect receipt; input processing is not world-effect confirmation", jsonSchema.parse(receipt));
  // Reuse the adapter's ordinary GUI receipt interpreter with the actual authored
  // transaction. This creates no finite action row, admission, retry or writer.
  const facts = input.kind === "screen" ? adapter.effectEvidence?.(receipt.scope, receipt.input_id,
    { kind: "screen_input", screen: input.screen, operations: input.operations }, update.result, retained.at) ?? [] : [];
  for (const fact of facts) store.event(execution.run_id, "adapter.evidence", "Adapter-owned resident receipt fact", jsonSchema.parse(fact));
  return facts;
}
