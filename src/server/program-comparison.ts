import type { Json } from "../shared/contracts.ts";
import type { ProgramVersionEvidence, VersionComparison } from "../shared/execution-evidence.ts";
import type { Store } from "./store.ts";
import { exactVersion } from "./improvement-learning.ts";
import { objectiveMetrics } from "./objective-metrics.ts";
import { RuntimeFault } from "./runtime-fault.ts";
export type ComparisonScope =
  | { kind: "model"; run_id: string; model_id: string }
  | { kind: "operator" };

/** Exact source/card changes alongside raw observed samples; no causal promotion. */
export function compareProgramVersions(store: Store, before: ProgramVersionEvidence, after: ProgramVersionEvidence, trustedScope: ComparisonScope, conditions: Json | null = null): VersionComparison {
  const leftRun = store.getRun(before.run_id), rightRun = store.getRun(after.run_id);
  if (trustedScope.kind === "model") {
    const caller = store.getRun(trustedScope.run_id);
    if (!caller || caller.model_id !== trustedScope.model_id || leftRun?.model_id !== caller.model_id || rightRun?.model_id !== caller.model_id)
      throw new RuntimeFault("forbidden", "Comparison references are outside the requesting model scope");
  } else if (trustedScope.kind !== "operator") throw new Error("Comparison requires trusted caller scope");
  if (!leftRun || !rightRun || leftRun.model_id !== rightRun.model_id) throw new Error("Comparison requires actual same-model version records");
  const left = exactVersion(store, before), right = exactVersion(store, after);
  const a = left.source.split("\n"), b = right.source.split("\n");
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const card_diff: VersionComparison["card_diff"] = {};
  for (const key of Object.keys(left.card) as (keyof typeof left.card)[]) if (left.card[key] !== right.card[key]) card_diff[key] = { before: left.card[key], after: right.card[key] };
  const samples = (ref: ProgramVersionEvidence) => {
    const ids = new Set(store.allSkillExecutions(ref.run_id).filter((execution) => execution.skill_id === ref.skill_id && execution.version === ref.version && execution.started_at !== null && execution.ended_at !== null).map((execution) => execution.execution_id));
    return objectiveMetrics(store, ref.run_id).filter((metric) => ids.has(metric.execution_id));
  };
  const oldSamples = samples(before), newSamples = samples(after);
  return {
    before, after,
    source_diff: { common_prefix_lines: prefix, common_suffix_lines: suffix, removed: a.slice(prefix, suffix ? -suffix : undefined), added: b.slice(prefix, suffix ? -suffix : undefined) },
    card_diff, samples: { before: oldSamples, after: newSamples }, sample_count: { before: oldSamples.length, after: newSamples.length },
    controlled_conditions: conditions, conclusion: "descriptive_only_no_causal_improvement_claim",
  };
}

export function compareProgramVersionsPage(store: Store, before: ProgramVersionEvidence, after: ProgramVersionEvidence, trustedScope: ComparisonScope, afterSample = 0, limit = 25) {
  if (!Number.isSafeInteger(afterSample) || afterSample < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid version comparison cursor or limit");
  const full = compareProgramVersions(store, before, after, trustedScope);
  const comparison: VersionComparison = { ...full, samples: { before: [], after: [] } };
  const page = {
    comparison,
    next_after: afterSample,
    has_more: false,
    omissions: [] as { field: string; reason: string; original_bytes: number; reference: Json }[],
  };
  if (Buffer.byteLength(JSON.stringify(comparison.source_diff)) > 8000) {
    page.omissions.push({ field: "source_diff", reason: "page_byte_budget_read_exact_sources", original_bytes: Buffer.byteLength(JSON.stringify(comparison.source_diff)), reference: { before: before as unknown as Json, after: after as unknown as Json } });
    comparison.source_diff = { ...comparison.source_diff, removed: [], added: [] };
  }
  if (Buffer.byteLength(JSON.stringify(comparison.card_diff)) > 4000) {
    page.omissions.push({ field: "card_diff", reason: "page_byte_budget_read_exact_cards", original_bytes: Buffer.byteLength(JSON.stringify(comparison.card_diff)), reference: { before: before as unknown as Json, after: after as unknown as Json } });
    comparison.card_diff = {};
  }
  const all = [
    ...full.samples.before.map((sample) => ({ side: "before" as const, sample })),
    ...full.samples.after.map((sample) => ({ side: "after" as const, sample })),
  ];
  for (const entry of all.slice(afterSample, afterSample + Math.min(limit, 100))) {
    const size = Buffer.byteLength(JSON.stringify(entry.sample));
    if (size > 48000) {
      const omission = { field: `samples.${entry.side}`, reason: "record_byte_budget_read_execution_evidence", original_bytes: size, reference: { execution_id: entry.sample.execution_id, run_id: entry.side === "before" ? before.run_id : after.run_id } };
      if (Buffer.byteLength(JSON.stringify({ ...page, omissions: [...page.omissions, omission], next_after: page.next_after + 1, has_more: false })) > 65536) break;
      page.omissions.push(omission);
      page.next_after++;
      continue;
    }
    const samples = { ...comparison.samples, [entry.side]: [...comparison.samples[entry.side], entry.sample] };
    if (Buffer.byteLength(JSON.stringify({ ...page, comparison: { ...comparison, samples }, next_after: page.next_after + 1, has_more: false })) > 65536) break;
    comparison.samples[entry.side].push(entry.sample);
    page.next_after++;
  }
  page.has_more = page.next_after < all.length;
  return page;
}
