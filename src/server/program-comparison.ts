import { createHash } from "node:crypto";
import type { Json } from "../shared/contracts.ts";
import type { ProgramVersionEvidence, VersionComparison, VersionComparisonCursor } from "../shared/execution-evidence.ts";
import type { StoreReadQueries } from "./store-read.ts";
import { exactVersion, type ProjectionProgress } from "./program-feedback.ts";
import { readProjectedObjectiveMetricsPage } from "./history-objective.ts";
import { RuntimeFault } from "./runtime-fault.ts";
export type ProgramComparisonReadStore = StoreReadQueries;
export type ComparisonScope =
  | { kind: "model"; run_id: string; model_id: string }
  | { kind: "operator" };
export interface VersionComparisonPage {
  comparison: VersionComparison;
  next_after: VersionComparisonCursor;
  has_more: boolean;
  omissions: { field: string; reason: string; original_bytes: number; reference: Json }[];
  projection: { before: ProjectionProgress; after: ProjectionProgress };
}

function authorize(store: ProgramComparisonReadStore, before: ProgramVersionEvidence, after: ProgramVersionEvidence, trustedScope: ComparisonScope): void {
  const leftRun = store.getRun(before.run_id), rightRun = store.getRun(after.run_id);
  if (trustedScope.kind === "model") {
    const caller = store.getRun(trustedScope.run_id);
    if (!caller || caller.model_id !== trustedScope.model_id || leftRun?.model_id !== caller.model_id || rightRun?.model_id !== caller.model_id)
      throw new RuntimeFault("forbidden", "Comparison references are outside the requesting model scope");
  } else if (trustedScope.kind !== "operator") throw new Error("Comparison requires trusted caller scope");
  if (!leftRun || !rightRun || leftRun.model_id !== rightRun.model_id) throw new Error("Comparison requires actual same-model version records");
}

function describe(store: ProgramComparisonReadStore, before: ProgramVersionEvidence, after: ProgramVersionEvidence): VersionComparison {
  const left = exactVersion(store, before), right = exactVersion(store, after);
  const a = left.source.split("\n"), b = right.source.split("\n");
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const card_diff: VersionComparison["card_diff"] = {};
  for (const key of Object.keys(left.card) as (keyof typeof left.card)[]) if (left.card[key] !== right.card[key]) card_diff[key] = { before: left.card[key], after: right.card[key] };
  return {
    before, after,
    source_diff: { common_prefix_lines: prefix, common_suffix_lines: suffix, removed: a.slice(prefix, suffix ? -suffix : undefined), added: b.slice(prefix, suffix ? -suffix : undefined) },
    card_diff, samples: { before: [], after: [] }, sample_count: { before: 0, after: 0 },
    controlled_conditions: null, conclusion: "descriptive_only_no_causal_improvement_claim",
  };
}
function fits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify({ id: Number.MAX_SAFE_INTEGER, ok: true, value }) + "\n") <= 65536;
}

/** Pins both complete populations before paging, preserving before-then-after insertion order. */
export function compareProgramVersionsPage(store: ProgramComparisonReadStore, before: ProgramVersionEvidence, after: ProgramVersionEvidence, trustedScope: ComparisonScope, afterSample: VersionComparisonCursor | null = null, limit = 25): VersionComparisonPage {
  authorize(store, before, after, trustedScope);
  const comparison = describe(store, before, after);
  if (!Number.isSafeInteger(limit) || limit < 1 || afterSample !== null && (afterSample.schema_version !== 2 ||
    !Number.isSafeInteger(afterSample.offset) || afterSample.offset < 0 ||
    !Number.isSafeInteger(afterSample.before_generation) || afterSample.before_generation < 0 ||
    !Number.isSafeInteger(afterSample.after_generation) || afterSample.after_generation < 0))
    throw new RuntimeFault("invalid_request", "Invalid version comparison V2 cursor or limit");
  const scopeHash = createHash("sha256").update(JSON.stringify(["comparison-v2", before.run_id, before.skill_id, before.version, before.hash,
    after.run_id, after.skill_id, after.version, after.hash, trustedScope.kind,
    trustedScope.kind === "model" ? trustedScope.run_id : null, trustedScope.kind === "model" ? trustedScope.model_id : null])).digest("hex");
  if (afterSample && afterSample.scope_hash !== scopeHash) throw new RuntimeFault("conflict", "Comparison cursor belongs to different versions or caller scope");
  const left = store.historyProjectionGeneration(before.run_id, afterSample?.before_generation);
  const right = store.historyProjectionGeneration(after.run_id, afterSample?.after_generation);
  if (!left || !right) throw new RuntimeFault("conflict", "Comparison requires retained complete published generations");
  const cap = Math.min(limit, 100);
  const offset = afterSample?.offset ?? 0;
  const read = (side: "before" | "after", start: number, count: number) => {
    const ref = side === "before" ? before : after;
    return readProjectedObjectiveMetricsPage(store, ref.run_id, { generation: side === "before" ? left.generation : right.generation,
      skill_id: ref.skill_id, version: ref.version, eligible_only: true, offset: start, limit: count });
  };
  const count = (ref: ProgramVersionEvidence, revision: number) => store.historyProjectionCount(ref.run_id, revision, {
    collection: "metric_population", source_id: ref.skill_id, tag: JSON.stringify([ref.skill_id, ref.version]),
  });
  const oldCount = count(before, left.revision), newCount = count(after, right.revision);
  comparison.sample_count = { before: oldCount, after: newCount };
  if (offset > oldCount + newCount) throw new RuntimeFault("invalid_request", "Comparison cursor is outside its pinned population");
  const progress = (value: typeof left): ProjectionProgress => ({ generation: value.generation, source_through: value.source_through, source_available: value.source_available, has_pending: value.has_pending });
  const page: VersionComparisonPage = {
    comparison, next_after: { schema_version: 2, before_generation: left.generation, after_generation: right.generation, offset, scope_hash: scopeHash },
    has_more: offset < oldCount + newCount, omissions: [], projection: { before: progress(left), after: progress(right) },
  };
  if (Buffer.byteLength(JSON.stringify(comparison.source_diff)) > 8000) {
    page.omissions.push({ field: "source_diff", reason: "page_byte_budget_read_exact_sources", original_bytes: Buffer.byteLength(JSON.stringify(comparison.source_diff)), reference: { before: before as unknown as Json, after: after as unknown as Json } });
    comparison.source_diff = { ...comparison.source_diff, removed: [], added: [] };
  }
  if (Buffer.byteLength(JSON.stringify(comparison.card_diff)) > 4000) {
    page.omissions.push({ field: "card_diff", reason: "page_byte_budget_read_exact_cards", original_bytes: Buffer.byteLength(JSON.stringify(comparison.card_diff)), reference: { before: before as unknown as Json, after: after as unknown as Json } });
    comparison.card_diff = {};
  }
  let consumed = 0;
  for (const side of ["before", "after"] as const) {
    const sideStart = side === "before" ? offset : Math.max(0, offset - oldCount);
    const sideCount = side === "before" ? oldCount : newCount;
    if (sideStart >= sideCount || consumed >= cap) continue;
    const values = read(side, sideStart, cap - consumed);
    if (values.metrics.length === 0) throw new RuntimeFault("conflict", "Pinned comparison population has missing metrics");
    for (const sample of values.metrics) {
      const next = { ...page.next_after, offset: page.next_after.offset + 1 };
      const size = Buffer.byteLength(JSON.stringify(sample));
      if (size > 48000) {
        const omission = { field: `samples.${side}`, reason: "record_byte_budget_read_execution_evidence", original_bytes: size,
          reference: { url: `/v1/runs/${encodeURIComponent(side === "before" ? before.run_id : after.run_id)}/objective-metrics/${encodeURIComponent(sample.execution_id)}?generation=${side === "before" ? left.generation : right.generation}&record_index=0&chunk_index=0&limit=25`,
            execution_id: sample.execution_id, run_id: side === "before" ? before.run_id : after.run_id,
            generation: side === "before" ? left.generation : right.generation } };
        if (!fits({ ...page, omissions: [...page.omissions, omission], next_after: next })) return page;
        page.omissions.push(omission);
      } else {
        const samples = { ...comparison.samples, [side]: [...comparison.samples[side], sample] };
        if (!fits({ ...page, comparison: { ...comparison, samples }, next_after: next })) return page;
        comparison.samples[side].push(sample);
      }
      page.next_after = next;
      consumed++;
    }
  }
  page.has_more = page.next_after.offset < oldCount + newCount;
  return page;
}

/** Explicit complete selected-version view; production RPCs use the pinned page API above. */
export function compareProgramVersions(store: ProgramComparisonReadStore, before: ProgramVersionEvidence, after: ProgramVersionEvidence, trustedScope: ComparisonScope, conditions: Json | null = null): VersionComparison {
  let page = compareProgramVersionsPage(store, before, after, trustedScope, null, 100);
  const result = describe(store, before, after);
  result.sample_count = page.comparison.sample_count;
  result.controlled_conditions = conditions;
  while (true) {
    result.samples.before.push(...page.comparison.samples.before);
    result.samples.after.push(...page.comparison.samples.after);
    if (page.omissions.some(omission => omission.field.startsWith("samples."))) throw new RuntimeFault("budget_exceeded", "Complete comparison contains oversized samples; use paged comparison references");
    if (!page.has_more) return result;
    if (page.next_after.offset === 0) throw new RuntimeFault("budget_exceeded", "Comparison page cannot make progress");
    const previous = page.next_after.offset;
    page = compareProgramVersionsPage(store, before, after, trustedScope, page.next_after, 100);
    if (page.has_more && page.next_after.offset <= previous) throw new RuntimeFault("budget_exceeded", "Comparison page cannot make progress");
  }
}
