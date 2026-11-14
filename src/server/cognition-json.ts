import { z } from "zod";
import type { Json } from "../shared/contracts.ts";

/** Validate JSON DATA without Zod record reconstruction (which can omit __proto__). */
export function isCognitionJson(value: unknown): value is Json {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 100_000 || item.depth > 64) return false;
    const input = item.value;
    if (input === null || typeof input === "boolean" || typeof input === "string") continue;
    if (typeof input === "number") { if (!Number.isFinite(input)) return false; continue; }
    if (typeof input !== "object" || seen.has(input)) return false;
    seen.add(input);
    const array = Array.isArray(input), prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== "string")) return false;
    if (array && (keys.length !== input.length + 1 || !keys.includes("length"))) return false;
    for (const key of keys) {
      if (array && key === "length") continue;
      if (array && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return true;
}
export const cognitionJsonSchema = z.custom<Json>(isCognitionJson, "Expected bounded uncoerced JSON data");

/** Exact own-data identity; neither stringify nor user toJSON may erase fields. */
export function sameCognitionArguments(left: unknown, right: unknown): boolean {
  if (!isCognitionJson(left) || !isCognitionJson(right)) return false;
  const pending: [Json, Json][] = [[left, right]];
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false;
      pending.push([Object.getOwnPropertyDescriptor(a, key)!.value, Object.getOwnPropertyDescriptor(b, key)!.value]);
    }
  }
  return true;
}
