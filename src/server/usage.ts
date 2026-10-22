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
    by_purpose: Object.fromEntries(
      USAGE_PURPOSES.map((p) => [p, emptyTokenUsage()]),
    ) as RunUsage["by_purpose"],
  };
}
export function recordUsage(
  usage: RunUsage,
  purpose: UsagePurpose,
  reported: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  },
): void {
  for (const counter of [usage, usage.by_purpose[purpose]]) {
    if (counter.uncached_input !== null)
      counter.uncached_input += reported.input;
    if (counter.cache_read !== null) counter.cache_read += reported.cacheRead;
    if (counter.cache_write !== null)
      counter.cache_write += reported.cacheWrite;
    counter.output += reported.output;
  }
}
export function recordCall(usage: RunUsage, purpose: UsagePurpose): void {
  if (usage.calls !== null) usage.calls++;
  if (usage.by_purpose[purpose].calls !== null)
    usage.by_purpose[purpose].calls++;
}
