import { randomUUID } from "node:crypto";
import type { AdapterEvidence, RuntimeAdapter } from "../shared/contracts.ts";
import type { EffectContext } from "../shared/control.ts";
import type { ObservationV3 } from "../shared/observations.ts";
import { jsonSchema } from "../shared/primitives.ts";

/** Trusted read invocation, never a fabricated skill execution or an actor-supplied effect grant. */
export function observationEvidence(adapter: RuntimeAdapter, context: EffectContext, observation: ObservationV3): AdapterEvidence {
  if (observation.world_id !== context.world_id || observation.session_id !== context.session_id || observation.epoch !== context.epoch ||
    observation.native_boot_id !== context.native_boot_id) throw new Error("Observation evidence belongs to another host context");
  const invocationId = `observe_${randomUUID()}`;
  return { evidence_id: invocationId, adapter_id: adapter.descriptor.adapter.id,
    schema: { id: "observation_v3", version: 3, hash: adapter.descriptor.observation.schema_hash },
    scope: { ...context, life_id: observation.life.life_id, space_epoch: observation.space.space_epoch,
      execution_id: invocationId, source_hash: adapter.descriptor.adapter.build_hash },
    observed_at: observation.captured_at, data: jsonSchema.parse(observation) };
}
