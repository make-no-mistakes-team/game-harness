import type { ActiveExecutableValidation, AdapterBinding, Json } from "../shared/contracts.ts";
import type { EffectEnvelope, EffectInvocation, EffectScope, ScreenRef } from "../shared/control.ts";
import { effectEnvelopeSchema, sameEffectScope, screenPreconditionMatches } from "../shared/control.ts";
import { activeExecutableValidationSchema } from "../shared/adapter.ts";
import { jsonSchema } from "../shared/primitives.ts";
import { RuntimeFault } from "./runtime-fault.ts";

const envelopeSchema = effectEnvelopeSchema(jsonSchema);

/** Same fence for selected skills, dependencies, policies and trusted host diagnostics. */
export function assertExecutableCompatible(validation: unknown, binding: AdapterBinding): ActiveExecutableValidation {
  const parsed = activeExecutableValidationSchema.safeParse(validation);
  if (!binding.ready || !parsed.success || parsed.data.compatibility_hash !== binding.compatibility_hash)
    throw new RuntimeFault("precondition_failed", "Executable validation does not match the negotiated adapter contract; retained artifacts are read-only");
  return parsed.data;
}

/** A pure validation step used by the existing arbiter/bridge, never another queue or authority. */
export function assertCurrentEffect(value: unknown, expected: {
  binding: AdapterBinding;
  scope: EffectScope;
  invocation: EffectInvocation;
  screen: ScreenRef | null;
}): EffectEnvelope<Json> {
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) throw new RuntimeFault("invalid_authority", "Effect envelope does not match its host contract");
  const envelope = parsed.data;
  if (!expected.binding.ready || envelope.compatibility_hash !== expected.binding.compatibility_hash ||
    envelope.scope.native_boot_id !== expected.binding.native_boot_id || !sameEffectScope(envelope.scope, expected.scope))
    throw new RuntimeFault("stale_context", "Effect scope/profile belongs to obsolete host authority");
  const invocation = expected.invocation;
  if (envelope.invocation.kind !== invocation.kind || envelope.invocation.execution_id !== invocation.execution_id ||
    envelope.invocation.source_hash !== invocation.source_hash ||
    (envelope.invocation.kind === "policy" && (invocation.kind !== "policy" ||
      envelope.invocation.policy_id !== invocation.policy_id || envelope.invocation.version !== invocation.version)))
    throw new RuntimeFault("invalid_authority", "Effect invocation does not match the active host-created source owner");
  if (!screenPreconditionMatches(envelope.expected_screen, expected.screen))
    throw new RuntimeFault("stale_context", "Effect expected a replaced or revised screen instance");
  return envelope;
}
