export type ToolArgumentOverrun = { path: (string | number)[]; limit: number; observed: number };

type Plan = readonly Alternative[];
type Alternative = {
  maxLength?: number;
  literals?: readonly string[];
  types?: readonly string[];
  properties: ReadonlyMap<string, Plan>;
  items?: Plan;
  prefixItems?: readonly Plan[];
};

const UNKNOWN: Plan = [{ properties: new Map() }];
const MAX_DEPTH = 32;
const MAX_ALTERNATIVES = 64;
const MAX_WORK = 4096;
const MAX_PROPERTIES = 256;
const MAX_PATH_KEY_LENGTH = 128;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allows(alternative: Alternative, type: string): boolean {
  return alternative.types === undefined || alternative.types.includes(type);
}

/**
 * Compile the advertised input schema into a conservative generation-prefix
 * resource budget, NOT a JSON validator or proof of eventual invalidity.
 * Missing/malformed fields and numeric prefixes never invalidate alternatives.
 * Only recognized string literal discriminators can narrow a union; a longer
 * literal that can still grow from the current value remains compatible.
 *
 * The caller must stop on the first overrun. A later duplicate-key rewrite does
 * not renew the already-spent scalar-prefix budget. This pure function examines
 * one SDK partial-arguments snapshot and neither remembers nor rewrites it.
 *
 * JSON Schema counts Unicode code points, whereas some consumers use UTF-16
 * units and trim before validating. Counting the currently non-trimmable code
 * points is a safe lower bound for both, including split surrogate pairs. This
 * deliberately admits some overlong whitespace/UTF-16 inputs rather than
 * incorrectly rejecting a potentially valid trimmed or Unicode string.
 */
export function compileToolArgumentBudget(schema: unknown): (argumentsValue: unknown) => ToolArgumentOverrun | null {
  let work = MAX_WORK;

  function intersect(left: Plan, right: Plan, depth: number): Plan {
    if (depth > MAX_DEPTH || left.length * right.length > MAX_ALTERNATIVES) return UNKNOWN;
    const alternatives: Alternative[] = [];
    for (const a of left) for (const b of right) {
      if (--work < 0) return UNKNOWN;
      const properties = new Map(a.properties);
      for (const [key, child] of b.properties) {
        const previous = properties.get(key);
        properties.set(key, previous ? intersect(previous, child, depth + 1) : child);
      }
      if (properties.size > MAX_PROPERTIES) return UNKNOWN;
      const types = a.types && b.types ? a.types.filter(type => b.types!.includes(type)) : a.types ?? b.types;
      const literals = a.literals && b.literals
        ? a.literals.filter(value => b.literals!.includes(value)) : a.literals ?? b.literals;
      const maxLength = a.maxLength === undefined ? b.maxLength : b.maxLength === undefined
        ? a.maxLength : Math.min(a.maxLength, b.maxLength);
      const prefixLength = Math.max(a.prefixItems?.length ?? 0, b.prefixItems?.length ?? 0);
      const prefixItems: Plan[] = [];
      for (let index = 0; index < prefixLength; index++) {
        const first = a.prefixItems?.[index] ?? a.items, second = b.prefixItems?.[index] ?? b.items;
        prefixItems.push(first && second ? intersect(first, second, depth + 1) : first ?? second ?? UNKNOWN);
      }
      alternatives.push({ properties, types, literals: literals?.length ? literals : undefined, maxLength,
        items: a.items && b.items ? intersect(a.items, b.items, depth + 1) : a.items ?? b.items,
        prefixItems: prefixItems.length ? prefixItems : undefined });
    }
    return alternatives;
  }

  function reference(pointer: string): unknown {
    if (pointer === "#") return schema;
    if (!pointer.startsWith("#/")) return undefined;
    let current = schema;
    try {
      for (const part of decodeURIComponent(pointer.slice(2)).split("/")) {
        const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!record(current) || !Object.hasOwn(current, key)) return undefined;
        current = current[key];
      }
      return current;
    } catch {
      return undefined;
    }
  }

  function compile(value: unknown, ancestors: ReadonlySet<object>, depth: number): Plan {
    if (--work < 0 || depth > MAX_DEPTH || !record(value) || ancestors.has(value)) return UNKNOWN;
    if (Object.hasOwn(value, "$dynamicRef") || Object.hasOwn(value, "$recursiveRef")) return UNKNOWN;
    const next = new Set(ancestors).add(value);
    let referenced: Plan = UNKNOWN;
    if (Object.hasOwn(value, "$ref")) {
      if (typeof value.$ref !== "string") return UNKNOWN;
      const target = reference(value.$ref);
      // Unknown/cyclic references cannot establish an advertised bound. Do not
      // assume their siblings are interpreted under a particular schema draft.
      if (!record(target) || next.has(target)) return UNKNOWN;
      referenced = compile(target, next, depth + 1);
      if (referenced === UNKNOWN) return UNKNOWN;
    }
    const properties = new Map<string, Plan>();
    if (record(value.properties)) {
      const keys = Object.keys(value.properties);
      if (keys.length > MAX_PROPERTIES) return UNKNOWN;
      for (const key of keys) {
        if (key.length <= MAX_PATH_KEY_LENGTH) properties.set(key, compile(value.properties[key], next, depth + 1));
      }
    }
    let prefixItems: Plan[] | undefined;
    const tuple = Array.isArray(value.prefixItems) ? value.prefixItems : Array.isArray(value.items) ? value.items : undefined;
    if (tuple) {
      if (tuple.length > MAX_PROPERTIES) return UNKNOWN;
      prefixItems = tuple.map(child => compile(child, next, depth + 1));
    }
    const literalValues = typeof value.const === "string" ? [value.const]
      : Array.isArray(value.enum) && value.enum.length > 0 && value.enum.length <= MAX_PROPERTIES &&
        value.enum.every(item => typeof item === "string") ? value.enum as string[] : undefined;
    const types = typeof value.type === "string" ? [value.type]
      : Array.isArray(value.type) && value.type.every(type => typeof type === "string") ? value.type as string[] : undefined;
    let plan: Plan = [{ properties, literals: literalValues, types,
      maxLength: typeof value.maxLength === "number" && Number.isSafeInteger(value.maxLength) && value.maxLength >= 0
        ? value.maxLength : undefined,
      items: record(value.items) || typeof value.items === "boolean" ? compile(value.items, next, depth + 1) : undefined,
      prefixItems }];
    if (Object.hasOwn(value, "$ref")) plan = intersect(plan, referenced, depth);
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      if (!Object.hasOwn(value, keyword)) continue;
      const children = value[keyword];
      if (!Array.isArray(children) || children.length === 0 || children.length > MAX_ALTERNATIVES) return UNKNOWN;
      if (keyword === "allOf") {
        for (const child of children) plan = intersect(plan, compile(child, next, depth + 1), depth);
      } else {
        const alternatives: Alternative[] = [];
        for (const child of children) {
          alternatives.push(...compile(child, next, depth + 1));
          if (alternatives.length > MAX_ALTERNATIVES) return UNKNOWN;
        }
        plan = intersect(plan, alternatives, depth);
      }
    }
    return plan;
  }

  const plan = compile(schema, new Set(), 0);

  function literals(plan: Plan | undefined): readonly string[] | undefined {
    if (!plan || plan.some(alternative => !alternative.literals || !allows(alternative, "string"))) return undefined;
    return plan.flatMap(alternative => alternative.literals!);
  }

  function compatible(plan: Plan, value: Record<string, unknown>): Plan {
    if (plan.length < 2) return plan;
    let selected = plan;
    const keys = new Set(plan.flatMap(alternative => [...alternative.properties.keys()]));
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) continue;
      const observed = value[key];
      if (typeof observed !== "string" || observed.length === 0) continue;
      // A partial/unrecognized discriminator cannot exclude other branches.
      if (!selected.some(alternative => literals(alternative.properties.get(key))?.includes(observed))) continue;
      selected = selected.filter(alternative => {
        const choices = literals(alternative.properties.get(key));
        return !choices || choices.some(choice => choice.startsWith(observed));
      });
    }
    return selected;
  }

  return argumentsValue => {
    let remaining = MAX_WORK;
    function visit(current: Plan, value: unknown, path: (string | number)[]): ToolArgumentOverrun | null {
      if (--remaining < 0 || path.length > MAX_DEPTH || current.length > MAX_ALTERNATIVES) return null;
      if (typeof value === "string") {
        let limit = 0;
        for (const alternative of current) {
          if (!allows(alternative, "string") || alternative.maxLength === undefined) return null;
          limit = Math.max(limit, alternative.maxLength);
        }
        // trim() copies potentially enormous input; find removable edges in
        // place, then count surrogate pairs without allocating a codepoint array.
        let start = 0, end = value.length;
        const whitespace = (index: number) => {
          const code = value.charCodeAt(index);
          return code >= 0x09 && code <= 0x0d || code === 0x20 || code === 0xa0 || code === 0x1680 ||
            code >= 0x2000 && code <= 0x200a || code === 0x2028 || code === 0x2029 ||
            code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
        };
        while (start < end && whitespace(start)) start++;
        while (end > start && whitespace(end - 1)) end--;
        let observed = 0;
        for (let index = start; index < end; index++, observed++) {
          const unit = value.charCodeAt(index);
          if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < end) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) index++;
          }
        }
        return observed > limit ? { path, limit, observed } : null;
      }
      if (Array.isArray(value)) {
        if (current.some(alternative => !allows(alternative, "array"))) return null;
        for (let index = 0; index < Math.min(value.length, MAX_PROPERTIES) && remaining >= 0; index++) {
          const children = current.map(alternative => alternative.prefixItems?.[index] ?? alternative.items);
          if (children.some(child => !child)) continue;
          const overrun = visit(children.flatMap(child => child!), value[index], [...path, index]);
          if (overrun) return overrun;
        }
      } else if (record(value)) {
        const selected = compatible(current, value);
        if (selected.some(alternative => !allows(alternative, "object"))) return null;
        // A property missing from any compatible branch is an unbounded
        // possibility. additionalProperties/patternProperties are not inferred.
        for (const key of selected[0]!.properties.keys()) {
          if (remaining < 0) break;
          if (!Object.hasOwn(value, key)) continue;
          const children = selected.map(alternative => alternative.properties.get(key));
          if (children.some(child => !child)) continue;
          const overrun = visit(children.flatMap(child => child!), value[key], [...path, key]);
          if (overrun) return overrun;
        }
      }
      return null;
    }
    return visit(plan, argumentsValue, []);
  };
}
