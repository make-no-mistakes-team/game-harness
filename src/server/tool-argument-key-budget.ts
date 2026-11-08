import type { ToolArgumentOverrun } from "./tool-argument-budget.ts";

export interface ToolArgumentKeyBudget {
  append(delta: string): ToolArgumentOverrun | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Only strict root objects have a finite property-name bound. Nested JSON stays unrestricted. */
function rootKeyLimit(root: unknown): number | null {
  let visited = 0;
  const visit = (value: unknown, depth: number): number | null => {
    if (++visited > 256 || depth > 24) return null;
    const schema = object(value);
    if (!schema) return null;
    if (typeof schema.$ref === "string") {
      if (!schema.$ref.startsWith("#/")) return null;
      let referenced: unknown = root;
      for (const part of schema.$ref.slice(2).split("/")) {
        const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
        const fields = object(referenced);
        if (!fields || !Object.hasOwn(fields, key)) return null;
        referenced = fields[key];
      }
      return visit(referenced, depth + 1);
    }
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) {
      if (!alternatives.length) return null;
      let longest = 0;
      for (const alternative of alternatives) {
        const limit = visit(alternative, depth + 1);
        if (limit === null) return null;
        longest = Math.max(longest, limit);
      }
      return longest;
    }
    if (Array.isArray(schema.allOf)) {
      let limit: number | null = null;
      for (const constraint of schema.allOf) {
        const candidate = visit(constraint, depth + 1);
        if (candidate !== null) limit = limit === null ? candidate : Math.min(limit, candidate);
      }
      return limit;
    }
    const properties = object(schema.properties), patterns = object(schema.patternProperties);
    if (schema.additionalProperties !== false || !properties || patterns && Object.keys(patterns).length) return null;
    let longest = 0;
    for (const key of Object.keys(properties)) longest = Math.max(longest, key.length);
    return longest;
  };
  return visit(root, 0);
}

/** Counts decoded UTF-16 units in first-root keys, without retaining their content.
 * SDK partial-JSON objects can hide an unfinished key indefinitely. Every legal
 * key in a strict root is bounded even when its quote has not arrived. */
export function createToolArgumentKeyBudget(schema: unknown): ToolArgumentKeyBudget | null {
  const limit = rootKeyLimit(schema);
  if (limit === null) return null;
  let depth = 0, started = false, done = false, inString = false, key = false;
  let expectKey = false, escaped = false, unicode = 0, keyLength = 0;
  let overrun: ToolArgumentOverrun | null = null;
  const count = () => {
    if (++keyLength > limit)
      overrun = { path: ["<argument_key>"], limit, observed: keyLength };
  };
  return {
    append(delta) {
      if (overrun || done) return overrun;
      for (let index = 0; index < delta.length; index++) {
        const char = delta[index]!;
        if (inString) {
          if (unicode) {
            if (!/[0-9a-fA-F]/.test(char)) { done = true; return null; }
            if (--unicode === 0) count();
          } else if (escaped) {
            escaped = false;
            if (key && char === "u") unicode = 4;
            else if (!'"\\/bfnrtu'.includes(char)) { done = true; return null; }
            else if (key) count();
          } else if (char === "\\") escaped = true;
          else if (char === '"') { inString = false; if (key) expectKey = false; key = false; }
          else if (char.charCodeAt(0) < 32) { done = true; return null; }
          else if (key) count();
          if (overrun) return overrun;
          continue;
        }
        if (!started) {
          if (/\s/.test(char)) continue;
          if (char !== "{") { done = true; return null; }
          started = true; depth = 1; expectKey = true; continue;
        }
        if (char === '"') {
          inString = true; key = depth === 1 && expectKey; keyLength = 0;
        } else if (char === "{" || char === "[") depth++;
        else if (char === "}" || char === "]") {
          if (--depth <= 0) { done = true; return null; }
        } else if (char === "," && depth === 1) expectKey = true;
      }
      return overrun;
    },
  };
}
