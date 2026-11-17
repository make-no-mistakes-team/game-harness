import { z } from "zod";
import { residentLimitsSchema } from "../shared/resident.ts";
import { controlSessionConfigSchema } from "../shared/control-session.ts";
import type { SkillStartRequest } from "../shared/programs.ts";
import { RuntimeFault } from "./runtime-fault.ts";

export type PlayingAuthorityCeilings = {
  limits: Readonly<Record<string, number>>;
  session: Readonly<Record<string, number | string>>;
};
export type PlayingAuthorityRequest = Readonly<{ limits?: unknown; session?: unknown }>;
export type VerifiedPlayingAuthority = Record<string, Record<string, number | string>>;
const fields = {
  limits: Object.keys(residentLimitsSchema.shape),
  session: Object.keys(controlSessionConfigSchema.shape),
};

/** Copy only complete own data fields. Defaults and accessors cannot declare authority. */
function completeData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) throw new Error();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) ||
        !["number", "string"].includes(typeof descriptor.value)) throw new Error();
    copy[key] = descriptor.value;
  }
  return copy;
}
const normalizedEnvelopeSchema = z.object({
  limits: residentLimitsSchema,
  session: controlSessionConfigSchema,
}).strict();
export const playingAuthorityEnvelopeSchema = z.unknown().transform((input, context) => {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== 2 ||
        !descriptors.limits || !("value" in descriptors.limits) ||
        !descriptors.session || !("value" in descriptors.session)) throw new Error();
    return { limits: completeData(descriptors.limits.value, fields.limits),
      session: completeData(descriptors.session.value, fields.session) };
  } catch {
    context.addIssue({ code: "custom", message: "A complete playing authority envelope is required" });
    return z.NEVER;
  }
}).pipe(normalizedEnvelopeSchema);
export type EffectivePlayingCeilings = z.infer<typeof playingAuthorityEnvelopeSchema>;
export type PlayingAuthorityRefusalDiagnostic = Readonly<{
  schema_version: 1;
  category: "invalid_declared_ceilings" | "request_authority_refused";
  violated_field: string | null;
  ceilings: EffectivePlayingCeilings | null;
  units: string;
  operation_admitted: false;
  authority_renewed: false;
  live_program_replacement: "actual_exact_handoff_required";
}>;

function refusal(category: PlayingAuthorityRefusalDiagnostic["category"],
  ceilings: EffectivePlayingCeilings | null, violated_field: string | null = null): RuntimeFault {
  const diagnostic: PlayingAuthorityRefusalDiagnostic = {
    schema_version: 1, category, violated_field, ceilings,
    units: "Resident callbacks/frames and semantic actions/calls are different units; callback/frame capacity does not increase action/call authority.",
    operation_admitted: false, authority_renewed: false,
    live_program_replacement: "actual_exact_handoff_required",
  };
  // Only validated trusted ceilings, known field names and static text are serialized.
  return new RuntimeFault("budget_exceeded", "Declared playing authority refused: " + JSON.stringify(diagnostic));
}

/** Validate once at configuration; keep a detached immutable effective envelope. */
export function validatePlayingAuthorityCeilings(ceilings: PlayingAuthorityCeilings): EffectivePlayingCeilings {
  let effective: EffectivePlayingCeilings;
  try { effective = playingAuthorityEnvelopeSchema.parse(ceilings); }
  catch { throw refusal("invalid_declared_ceilings", null); }
  Object.freeze(effective.limits); Object.freeze(effective.session);
  return Object.freeze(effective);
}

/** Disconnected operator and Runtime admission use the same complete numeric/enum check.
 * Refusal never quotes request values, caught errors, source or provider data.
 * This grants no admission, repair, retry, renewal or predecessor handoff.
 */
export function assertDeclaredPlayingAuthority(request: PlayingAuthorityRequest,
  ceilings: PlayingAuthorityCeilings): VerifiedPlayingAuthority {
  const effective = validatePlayingAuthorityCeilings(ceilings);
  return assertSelected(request, effective);
}

function assertSelected(request: PlayingAuthorityRequest, effective: EffectivePlayingCeilings): VerifiedPlayingAuthority {
  let selected: EffectivePlayingCeilings;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(request);
    if (!descriptors.limits || !("value" in descriptors.limits) ||
        !descriptors.session || !("value" in descriptors.session)) throw new Error();
    selected = playingAuthorityEnvelopeSchema.parse({
      limits: descriptors.limits.value, session: descriptors.session.value,
    });
  }
  catch { throw refusal("request_authority_refused", effective); }
  for (const group of ["limits", "session"] as const) {
    for (const key of fields[group]) {
      const maximum = (effective[group] as Record<string, number | string>)[key]!;
      const value = (selected[group] as Record<string, number | string>)[key]!;
      if (typeof maximum === "number"
        ? typeof value !== "number" || value > maximum || key === "schema_version" && value !== maximum
        : value !== maximum)
        throw refusal("request_authority_refused", effective, `${group}.${key}`);
    }
  }
  return selected;
}

/** A configured finite playing envelope permits only resident step sessions. */
export function assertPlayingProgramStart(request: SkillStartRequest, ceilings: EffectivePlayingCeilings): void {
  const effective = validatePlayingAuthorityCeilings(ceilings);
  let resident = false;
  try { resident = Object.getOwnPropertyDescriptor(request, "entry")?.value === "step"; }
  catch { /* Only a host-normalized resident entry can request this authority. */ }
  if (!resident) throw refusal("request_authority_refused", effective, "entry");
  assertSelected(request, effective);
}
