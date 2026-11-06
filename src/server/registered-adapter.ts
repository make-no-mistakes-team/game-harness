import { z } from "zod";
import type { AdapterDescriptor, AdapterSchemaCatalog, Json, ProgramCompatibility, RuntimeAdapter } from "../shared/contracts.ts";
import { observationV3Schema, type ObservationV3 } from "../shared/observations.ts";
import { jsonSchema } from "../shared/primitives.ts";
import { adapterCompatibility } from "./adapter-contract.ts";
import { RuntimeFault } from "./runtime-fault.ts";
import { isValidJsonSchema, validateJsonSchemaValue, type JsonSchemaValidationIssue } from "@oh-my-pi/pi-ai/utils/schema";

const expectedJsonTypeConstraints: Readonly<Record<string, string>> = {
  string: "must be a string", number: "must be a number", integer: "must be an integer",
  boolean: "must be a boolean", object: "must be an object", array: "must be an array", null: "must be null",
};

function declaredParameters(document: Json, names = new Set<string>()): Set<string> {
  if (document && typeof document === "object") {
    if (!Array.isArray(document) && document.properties && typeof document.properties === "object" && !Array.isArray(document.properties))
      for (const name of Object.keys(document.properties))
        if (/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name)) names.add(name);
    for (const value of Object.values(document)) declaredParameters(value, names);
  }
  return names;
}

function requestConstraint(issue: JsonSchemaValidationIssue, parameters: ReadonlySet<string>): string {
  // Paths may contain caller-authored additional-property keys. Only names from
  // the trusted schema are public; union guesses must not invent a constraint.
  const path = issue.path.length > 0 && issue.path.length <= 6 &&
    issue.path.every(part => typeof part === "string" && parameters.has(part))
    ? issue.path.join(".") : "arguments";
  const numeric = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"].includes(issue.keyword ?? "") &&
    /^must be (?:>=|<=|>|<) -?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(issue.message) && issue.message.length <= 100;
  if (issue.fromUnionBranch) return "arguments must match the registered capability schema";
  const expectedType = issue.keyword === "type" && issue.expectedTypes?.length === 1 ? issue.expectedTypes[0] : undefined;
  const typeConstraint = expectedType && Object.hasOwn(expectedJsonTypeConstraints, expectedType)
    ? expectedJsonTypeConstraints[expectedType] : undefined;
  return `${path} ${numeric ? issue.message : typeConstraint ?? (issue.keyword === "required" ? "is required" : "must match the registered constraint")}`;
}

function requestVariants(document: Json): { tags: [string, Json][]; document: Json }[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];
  const variants: { tags: [string, Json][]; document: Json }[] = [];
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = document[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!branch || typeof branch !== "object" || Array.isArray(branch) || !Array.isArray(branch.required)) continue;
      const properties = branch.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
      const tags: [string, Json][] = [];
      for (const name of branch.required) {
        if (typeof name !== "string") continue;
        const property = properties[name];
        if (property && typeof property === "object" && !Array.isArray(property) && Object.hasOwn(property, "const") &&
          (property.const === null || typeof property.const !== "object")) tags.push([name, property.const!]);
      }
      if (!tags.length) continue;
      // Diagnostic-only: retain the root for local references and all other
      // constraints, but avoid the SDK's optional-enum union tag selection.
      const diagnostic = { ...document };
      delete diagnostic[keyword];
      diagnostic.allOf = [...(Array.isArray(document.allOf) ? document.allOf : []), branch];
      variants.push({ tags, document: diagnostic });
    }
  }
  return variants;
}

function compileRegisteredSchema(document: Json, request = false): z.ZodType<Json> {
  if (typeof document !== "boolean" && (document === null || typeof document !== "object" || Array.isArray(document)))
    throw new Error("A registered adapter schema must be a JSON schema object or boolean");
  if (!isValidJsonSchema(document)) throw new Error("Registered adapter document is not a supported valid JSON schema");
  // The installed converter may strip unknown object keys. Validate the actual
  // document without transforming input before the finite-JSON decode instead.
  // This retains legitimate adapter fields named scope/epoch and rejects keys
  // only where the registered schema itself closes that object.
  const parameters = request ? declaredParameters(document) : null;
  const variants = request ? requestVariants(document) : [];
  return z.unknown().superRefine((value, context) => {
    const result = validateJsonSchemaValue(document, value);
    let issues = result.issues;
    if (!result.success && value && typeof value === "object" && !Array.isArray(value)) {
      const selected = variants.filter(variant => variant.tags.every(([name, tag]) =>
        Object.hasOwn(value, name) && (value as Record<string, unknown>)[name] === tag));
      if (selected.length === 1) {
        const diagnostic = validateJsonSchemaValue(selected[0]!.document, value);
        if (!diagnostic.success) issues = diagnostic.issues;
      }
    }
    for (const issue of issues)
      context.addIssue({ code: "custom", path: issue.path, message: parameters ? requestConstraint(issue, parameters) : issue.message });
  }).pipe(jsonSchema);
}

/** One compilation per stable registration; payloads/actions never compile schemas or hash source per frame. */
export class RegisteredAdapterContract {
  readonly compatibility: ProgramCompatibility;
  private readonly observationSchema: z.ZodType<ObservationV3>;
  private readonly capabilities: Record<string, z.ZodType<Json>> = Object.create(null);
  constructor(descriptor: AdapterDescriptor, schemas: AdapterSchemaCatalog, validators: RuntimeAdapter["capabilityValidators"] = {}) {
    this.compatibility = adapterCompatibility(descriptor, schemas);
    this.observationSchema = observationV3Schema.extend({ data: compileRegisteredSchema(schemas.payload) });
    for (const capability of this.compatibility.descriptor.capabilities) {
      const key = `${capability.id}@${capability.version}`;
      const schema = compileRegisteredSchema(schemas.capabilities[key]!, true);
      const validate = validators[key];
      // Some adapter invariants span ordered events and are not expressible in
      // JSON Schema. Keep their trusted predicates outside serialized contracts.
      this.capabilities[key] = validate ? schema.refine(validate,
        { message: "arguments must match the registered semantic constraints" }) : schema;
    }
  }
  parseObservation(value: unknown): ObservationV3 {
    const observation = this.observationSchema.parse(value);
    const descriptor = this.compatibility.descriptor;
    if (observation.compatibility_hash !== this.compatibility.compatibility_hash || observation.profile_id !== descriptor.observation.profile.id ||
      observation.profile_configuration_hash !== descriptor.observation.profile.configuration_hash)
      throw new RuntimeFault("stale_context", "Observation does not match its registered adapter/profile contract");
    return observation;
  }
  parseCapability(id: string, version: number, args: unknown): Json {
    const schema = this.capabilities[`${id}@${version}`];
    if (!schema) throw new RuntimeFault("precondition_failed", "The negotiated adapter does not implement the requested capability schema");
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      // This is the registered request-validation boundary, not a classifier
      // for arbitrary host Zod exceptions. No effect/action has been admitted.
      const constraints = parsed.error.issues.slice(0, 3)
        .map(issue => issue.code === "custom" ? issue.message : "arguments must be finite JSON").join("; ").slice(0, 800);
      throw new RuntimeFault("invalid_request",
        `Invalid capability arguments: ${constraints}. Rejected before effect admission; no action admitted.`);
    }
    return parsed.data;
  }
  capabilitySchema(id: string, version: number): z.ZodType {
    const schema = this.capabilities[`${id}@${version}`];
    if (!schema) throw new RuntimeFault("precondition_failed", "The negotiated adapter does not implement the requested capability schema");
    return schema;
  }
}
