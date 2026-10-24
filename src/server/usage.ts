import type {
  RunUsage,
  TokenUsage,
  UsagePurpose,
} from "../shared/contracts.ts";
export const USAGE_PURPOSES: UsagePurpose[] = [
  "authoring",
  "planning",
  "replanning",
  "improvement",
  "other",
];
export function emptyTokenUsage(): TokenUsage {
  return {
    uncached_input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    calls: 0,
    known_cost: null,
    legacy_input: null,
  };
}
export function emptyRunUsage(): RunUsage {
  return {
    ...emptyTokenUsage(),
    accounting_basis: "sdk_reported_subtotal",
    by_purpose: Object.fromEntries(
      USAGE_PURPOSES.map((p) => [p, emptyTokenUsage()]),
    ) as RunUsage["by_purpose"],
  };
}
export function recordUsage(
  usage: RunUsage,
  purpose: UsagePurpose,
  reported: {
    input: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
  },
): void {
  for (const counter of [usage, usage.by_purpose[purpose]]) {
    // Legacy null breakdowns stay unknown; a current accumulator may begin with
    // no reported contribution and become a subtotal when one actually arrives.
    const current = counter.calls !== null && counter.legacy_input === null;
    if ((current || counter.uncached_input !== null) && valid(reported.input))
      counter.uncached_input = (counter.uncached_input ?? 0) + reported.input;
    if ((current || counter.cache_read !== null) && valid(reported.cacheRead))
      counter.cache_read = (counter.cache_read ?? 0) + reported.cacheRead;
    if ((current || counter.cache_write !== null) && valid(reported.cacheWrite))
      counter.cache_write = (counter.cache_write ?? 0) + reported.cacheWrite;
    if ((current || counter.output !== null) && valid(reported.output))
      counter.output = (counter.output ?? 0) + reported.output;
  }
}
const valid = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
export function recordCall(usage: RunUsage, purpose: UsagePurpose): void {
  for (const counter of [usage, usage.by_purpose[purpose]]) {
    if (counter.calls === 0 && counter.legacy_input === null) {
      counter.uncached_input = null;
      counter.cache_read = null;
      counter.cache_write = null;
      counter.output = null;
    }
    if (counter.calls !== null) counter.calls++;
  }
}
