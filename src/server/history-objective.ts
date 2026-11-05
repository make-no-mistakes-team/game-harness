import type { Json } from "../shared/contracts.ts";
import type {
  ObjectiveMetrics,
  TraceRecord,
} from "../shared/execution-evidence.ts";
import {
  historicalObservationV2Schema,
  minecraftObservationV3Schema,
  type MinecraftPlayer,
} from "../shared/minecraft.ts";
import type { StoreReadQueries } from "./store-read.ts";
import type {
  HistorySourceKind,
  HistorySourceRecord,
} from "./history-source.ts";
import type {
  ProjectionCollection,
  ProjectionDraft,
  ProjectionQuery,
  ProjectionRow,
} from "./history-projection.ts";
import { addHistorySum, historySumValue } from "./history-sum.ts";
import {
  confirmedRemoval,
  evidenceObject,
  receiptedInventoryDelta,
} from "./objective-metrics.ts";

const BASE_LIMITATIONS = [
  "Travel and rotation are sampled authorized observations, not a complete trajectory.",
  "Block removals are not classified as necessary or wrong; item origin and tree identity are unknown.",
  "Span categories can overlap and must not be summed as exclusive wall time.",
];
const NO_SAMPLES = "No persisted authorized observation samples.";
const INCOMPLETE =
  "Trace omissions or incomplete diagnostic tails prevent complete execution reconstruction; retained gameplay receipts remain independently assessable.";
const BRANCH_OMISSION =
  "Source-branch diagnostic decisions were omitted by the worker budget; gameplay receipt validity is unchanged.";
const terminalTypes = new Set([
  "action.succeeded",
  "action.failed",
  "action.cancelled",
  "action.unknown",
]);
const key = (...parts: (string | number)[]): string => JSON.stringify(parts);
const object = (row: ProjectionRow | null): Record<string, Json> =>
  evidenceObject(row?.value) ?? {};
const row = (
  collection: ProjectionCollection,
  k: string,
  owner: string | null,
  source: string | null,
  order: number,
  tag: string | null,
  value: Json,
): ProjectionRow => ({
  collection,
  key: k,
  owner_id: owner,
  source_id: source,
  order_seq: order,
  tag,
  value,
});
const dirty = (
  draft: ProjectionDraft,
  type: string,
  id: string,
  order = 0,
): boolean =>
  draft.put(
    row("dirty_objective", key(type, id), id, null, order, type, { id }),
  );
function replay(draft: ProjectionDraft, id: string, sequence: number): boolean {
  const k = key("trace", id),
    previous = draft.get("dirty_objective", k);
  return draft.put(
    row(
      "dirty_objective",
      k,
      id,
      null,
      Math.min(sequence, previous?.order_seq ?? sequence),
      "trace",
      { id },
    ),
  );
}
function executionValue(
  draft: ProjectionDraft,
  record: HistorySourceRecord,
): Record<string, Json> {
  const value = draft.store.decodeHistorySource("execution", record);
  return {
    execution_id: value.execution_id,
    root_execution_id: value.root_execution_id,
    skill_id: value.skill_id,
    version: value.version,
    program_name: draft.source.skill(draft.runId, value).name,
    execution_ordinal: record.columns.admission_ordinal!,
    status: value.status,
    started_at: value.started_at,
    ended_at: value.ended_at,
    parent_execution_id: value.parent_execution_id,
  };
}

/** Source hooks only index identities and enqueue durable, bounded work. */
export function indexObjectiveSource(
  draft: ProjectionDraft,
  kind: HistorySourceKind,
  record: HistorySourceRecord | null,
  sourceKey: string,
): boolean {
  if (kind === "execution") {
    const previous = draft.get("execution", sourceKey);
    let attributionChanged = previous !== null,
      metricChanged = previous !== null;
    if (record) {
      const value = executionValue(draft, record);
      const old = object(previous);
      attributionChanged =
        !previous || old.root_execution_id !== value.root_execution_id;
      metricChanged =
        !previous ||
        Object.keys(value).some((field) => old[field] !== value[field]);
      const index = row(
        "execution",
        sourceKey,
        String(value.root_execution_id),
        String(value.skill_id),
        Number(value.execution_ordinal),
        key(String(value.skill_id), Number(value.version)),
        value,
      );
      if (!draft.put(index)) return false;
      if (value.started_at && value.ended_at) {
        if (!draft.put({ ...index, collection: "metric_population" }))
          return false;
      } else if (!draft.delete("metric_population", sourceKey)) return false;
    } else if (
      !draft.delete("execution", sourceKey) ||
      !draft.delete("metric_population", sourceKey)
    )
      return false;
    // Calls/actions-only progress is still indexed by the evidence hook. Neither it
    // nor an outcome/interval change alters existing action or trace attribution.
    return (
      (!attributionChanged ||
        dirty(
          draft,
          "execution",
          sourceKey,
          previous?.order_seq ?? record?.ordinal ?? 0,
        )) &&
      (!metricChanged || dirty(draft, "metric", sourceKey))
    );
  }
  if (kind === "action") {
    if (record) {
      const action = draft.store.decodeHistorySource("action", record),
        owner = action.view.execution_id;
      const execution = owner
        ? draft.source.skillExecution(draft.runId, { execution_id: owner })
        : null;
      if (
        !draft.put(
          row(
            "action",
            sourceKey,
            owner ?? null,
            execution?.root_execution_id ?? null,
            record.ordinal,
            null,
            {},
          ),
        )
      )
        return false;
    } else if (!draft.delete("action", sourceKey)) return false;
    return dirty(draft, "action", sourceKey);
  }
  if (kind === "event") {
    const previous = draft.get("terminal", sourceKey);
    if (previous && !dirty(draft, "action", previous.source_id!)) return false;
    if (record) {
      const event = draft.store.decodeHistorySource("event", record),
        details = evidenceObject(event.details);
      if (
        terminalTypes.has(event.type) &&
        typeof details?.action_id === "string"
      ) {
        return (
          draft.put(
            row(
              "terminal",
              sourceKey,
              details.action_id,
              details.action_id,
              event.event_seq,
              null,
              {},
            ),
          ) && dirty(draft, "action", details.action_id)
        );
      }
    }
    return draft.delete("terminal", sourceKey);
  }
  if (kind === "trace") {
    const old = draft.page({
      collection: "observation",
      source_id: sourceKey,
      limit: 3,
    });
    for (const item of old)
      if (
        !draft.delete("observation", item.key) ||
        !replay(draft, item.owner_id!, item.order_seq)
      )
        return false;
    if (record) {
      const trace = draft.store.decodeHistorySource("trace", record);
      for (const id of new Set([trace.execution_id, trace.root_execution_id]))
        if (id) {
          if (
            !draft.put(
              row(
                "observation",
                key(id, sourceKey),
                id,
                sourceKey,
                trace.trace_seq,
                null,
                {},
              ),
            ) ||
            !replay(draft, id, trace.trace_seq)
          )
            return false;
        }
    }
    return true;
  }
  if (kind === "trace_budget") {
    const omitted = record
      ? draft.store.decodeHistorySource("trace_budget", record).omitted_records
      : 0;
    const previous = object(draft.get("run_state", "objective_budget")).omitted;
    if (
      !draft.put(
        row("run_state", "objective_budget", null, null, 0, null, { omitted }),
      )
    )
      return false;
    return previous === omitted || dirty(draft, "all_metrics", draft.runId);
  }
  return true;
}

type Contribution = { field: string; amount: number; item?: string };
function applyNumber(
  draft: ProjectionDraft,
  owner: string,
  contribution: Contribution,
  subtract: boolean,
): boolean {
  const { field, amount, item } = contribution;
  const collection = item === undefined ? "metric_number" : "metric_item";
  const k = item === undefined ? key(owner, field) : key(owner, field, item);
  const previous = object(draft.get(collection, k));
  const coefficient = addHistorySum(
    typeof previous.coefficient === "string" ? previous.coefficient : "0",
    amount,
    subtract,
  );
  const presence = Number(previous.presence ?? 0) + (subtract ? -1 : 1);
  if (presence < 0)
    throw new Error("Objective contribution presence underflow");
  if (!presence) {
    if (!draft.delete(collection, k)) return false;
  } else if (
    !draft.put(
      row(collection, k, owner, item ?? null, 0, field, {
        coefficient,
        presence,
      }),
    )
  )
    return false;
  return dirty(draft, "metric", owner);
}
function putContribution(
  draft: ProjectionDraft,
  collection: "action_item" | "trace_applied",
  k: string,
  owner: string,
  source: string,
  order: number,
  contribution: Contribution,
): boolean {
  return (
    applyNumber(draft, owner, contribution, false) &&
    draft.put(
      row(
        collection,
        k,
        owner,
        source,
        order,
        "number",
        contribution as unknown as Json,
      ),
    )
  );
}
function removeContribution(
  draft: ProjectionDraft,
  item: ProjectionRow,
): boolean {
  const value = object(item);
  return (
    applyNumber(
      draft,
      item.owner_id!,
      {
        field: String(value.field),
        amount: Number(value.amount),
        ...(typeof value.item === "string" ? { item: value.item } : {}),
      },
      true,
    ) && draft.delete(item.collection, item.key)
  );
}
/** Nonnull streams are independent; inserting/removing one repairs only its two edges. */
function changeStream(
  draft: ProjectionDraft,
  collection: "target" | "position",
  entry: ProjectionRow,
  insert: boolean,
): boolean {
  const all = { collection, owner_id: entry.owner_id!, limit: 1 };
  const previous = draft.page({
    ...all,
    before_order: entry.order_seq,
    descending: true,
  })[0];
  const next = draft.page({ ...all, after_order: entry.order_seq })[0];
  const token = object(entry).token,
    left = object(previous ?? null).token,
    right = object(next ?? null).token;
  const edge = (a: Json | undefined, b: Json | undefined): number =>
    a !== undefined && b !== undefined && a !== b ? 1 : 0;
  const change = edge(left, token) + edge(token, right) - edge(left, right);
  if (
    change &&
    !applyNumber(
      draft,
      entry.owner_id!,
      {
        field:
          collection === "target"
            ? "target_switches"
            : "target_position_switches",
        amount: insert ? change : -change,
      },
      false,
    )
  )
    return false;
  if (!dirty(draft, "metric", entry.owner_id!)) return false;
  return insert ? draft.put(entry) : draft.delete(collection, entry.key);
}

type ActionPart = {
  owner: string;
  contribution?: Contribution;
  stream?: "target" | "position";
  token?: string;
  provenance?: true;
};
function actionParts(
  draft: ProjectionDraft,
  actionId: string,
): { order: number; parts: ActionPart[] } {
  const terminal = draft.page({
    collection: "terminal",
    source_id: actionId,
    limit: 1,
  })[0];
  const action = draft.source.getAction(draft.runId, actionId),
    ownerId = action?.view.execution_id;
  if (!terminal || !action || !ownerId) return { order: 0, parts: [] };
  const owner = draft.get("execution", ownerId);
  if (!owner) return { order: 0, parts: [] };
  const receipt = evidenceObject(action.view.result?.evidence),
    parts: ActionPart[] = [];
  const contributions: Contribution[] = [];
  if (confirmedRemoval(action)) {
    contributions.push(
      { field: "confirmed_block_removals", amount: 1 },
      {
        field: "removed_blocks",
        item:
          typeof receipt?.target_name === "string"
            ? receipt.target_name
            : "unknown",
        amount: 1,
      },
    );
  }
  const delta = receiptedInventoryDelta(action);
  if (delta) {
    contributions.push({ field: "inventory_receipts", amount: 1 });
    for (const [item, amount] of Object.entries(delta))
      contributions.push({ field: "inventory_delta", item, amount });
  }
  if (
    typeof receipt?.travel_distance === "number" &&
    Number.isFinite(receipt.travel_distance) &&
    receipt.travel_distance >= 0
  )
    contributions.push(
      { field: "receipted_travel_distance", amount: receipt.travel_distance },
      { field: "motion_receipts", amount: 1 },
    );
  if (
    typeof receipt?.rotation_yaw_radians === "number" &&
    typeof receipt.rotation_pitch_radians === "number" &&
    Number.isFinite(receipt.rotation_yaw_radians) &&
    Number.isFinite(receipt.rotation_pitch_radians)
  )
    contributions.push({
      field: "receipted_rotation_degrees",
      amount:
        ((Math.abs(receipt.rotation_yaw_radians) +
          Math.abs(receipt.rotation_pitch_radians)) *
          180) /
        Math.PI,
    });
  for (const [field, category] of [
    ["native_action_ms", "native_action"],
    ["native_dispatch_queue_ms", "dispatch"],
    ["native_baseline_receipt_wait_ms", "readiness"],
    ["native_dispatch_receipt_ms", "receipt"],
    ["native_respawn_readiness_wait_ms", "readiness"],
    ["native_life_recovery_ms", "life_recovery"],
  ] as const) {
    const duration = receipt?.[field];
    if (
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0
    )
      contributions.push(
        { field: "spans_ms", item: category, amount: duration },
        { field: "span_samples", item: category, amount: 1 },
      );
  }
  const targetRef = evidenceObject(action.request.target);
  const target = targetRef
    ? JSON.stringify(targetRef)
    : typeof action.request.target_id === "string"
      ? `historical:${action.request.target_id}`
      : null;
  const position = receipt?.target_position
    ? JSON.stringify({
        scope: action.view.scope
          ? {
              world_id: action.view.scope.world_id,
              session_id: action.view.scope.session_id,
              native_boot_id: action.view.scope.native_boot_id,
              space_epoch: action.view.scope.space_epoch,
            }
          : { historical_session: action.view.session_id },
        position: receipt.target_position,
      })
    : null;
  for (const id of new Set([ownerId, String(object(owner).root_execution_id)]))
    if (draft.get("execution", id)) {
      for (const contribution of contributions)
        parts.push({ owner: id, contribution });
      if (target !== null)
        parts.push({ owner: id, stream: "target", token: target });
      if (position !== null)
        parts.push({ owner: id, stream: "position", token: position });
      parts.push({ owner: id, provenance: true });
    }
  return { order: terminal.order_seq, parts };
}

type Sample = { scope: string; sequence: number; player: MinecraftPlayer };
function traceSample(trace: TraceRecord): Sample | null {
  const payload = evidenceObject(trace.payload);
  if (trace.kind === "observation" && payload?.schema_version === 3) {
    const parsed = minecraftObservationV3Schema.safeParse(trace.payload);
    if (parsed.success) {
      const value = parsed.data;
      return {
        scope: key(
          3,
          value.world_id,
          value.session_id,
          value.epoch,
          value.native_boot_id,
          value.life.life_id,
          JSON.stringify(value.space),
        ),
        sequence: value.observation_seq,
        player: value.data.player,
      };
    }
  } else if (trace.kind === "observation" && payload?.schema_version === 2) {
    const parsed = historicalObservationV2Schema.safeParse(trace.payload);
    if (parsed.success)
      return {
        scope: key(
          2,
          parsed.data.world_id,
          parsed.data.session_id,
          parsed.data.epoch,
          parsed.data.life.life_id,
        ),
        sequence: parsed.data.observation_seq,
        player: parsed.data.player,
      };
  }
  return null;
}
function sampleIdentity(owner: string, sample: Sample): string {
  return key(owner, sample.scope, sample.sequence);
}
function traceParts(
  draft: ProjectionDraft,
  owner: string,
  trace: TraceRecord,
): { contributions: Contribution[]; reasons: string[]; sample: Sample | null } {
  const payload = evidenceObject(trace.payload),
    contributions: Contribution[] = [],
    reasons: string[] = [];
  if (trace.omission) reasons.push("record omission");
  if (
    trace.kind === "branch" &&
    typeof payload?.omitted === "number" &&
    payload.omitted > 0
  )
    reasons.push(BRANCH_OMISSION);
  if (trace.kind === "branch" && payload?.tail_incomplete === true)
    reasons.push(
      `Source-branch diagnostic tail is incomplete (${typeof payload.loss_reason === "string" ? payload.loss_reason : "unknown"}); missing decision count is unknown and gameplay receipt validity is unchanged.`,
    );
  const sample = traceSample(trace);
  if (sample && !draft.get("trace_tail", sampleIdentity(owner, sample))) {
    contributions.push({ field: "observation_samples", amount: 1 });
    const previous = draft.page({
      collection: "trace_tail",
      owner_id: owner,
      before_order: trace.trace_seq,
      descending: true,
      limit: 1,
    })[0];
    const old = object(previous ?? null);
    if (previous && old.scope === sample.scope) {
      const a = old.player as unknown as MinecraftPlayer,
        b = sample.player;
      contributions.push(
        {
          field: "sampled_travel_distance",
          amount: Math.hypot(
            b.position.x - a.position.x,
            b.position.y - a.position.y,
            b.position.z - a.position.z,
          ),
        },
        {
          field: "sampled_rotation_degrees",
          amount:
            ((Math.abs(
              Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)),
            ) +
              Math.abs(b.pitch - a.pitch)) *
              180) /
            Math.PI,
        },
      );
    }
    return { contributions, reasons, sample };
  }
  if (
    !sample &&
    trace.kind === "span" &&
    payload?.clock === "same_process_monotonic" &&
    typeof payload.category === "string" &&
    typeof payload.duration_ms === "number" &&
    Number.isFinite(payload.duration_ms) &&
    payload.duration_ms >= 0
  )
    contributions.push(
      {
        field: "spans_ms",
        item: payload.category,
        amount: payload.duration_ms,
      },
      { field: "span_samples", item: payload.category, amount: 1 },
    );
  return { contributions, reasons, sample: null };
}

type Job = {
  type: string;
  id: string;
  phase: string;
  after?: { order_seq: number; key: string };
  collection?: number;
  start?: number;
  index?: number;
  source?: string;
};
type ActionPlan = {
  runId: string;
  through: number;
  id: string;
  source: string | undefined;
  before: ProjectionDraft["before"];
  nextIndex: number;
  value: ReturnType<typeof actionParts>;
};
// One immutable decoded plan per reader, never a history-sized map or checkpoint.
// The durable job index remains authoritative; dropping this cache only costs one
// normalization of the current receipt, including after cancellation or reopen.
const actionPlans = new WeakMap<StoreReadQueries, ActionPlan>();
function actionPlan(
  draft: ProjectionDraft,
  job: Job,
): ReturnType<typeof actionParts> {
  const index = job.index ?? 0,
    cached = actionPlans.get(draft.store);
  const continues =
    cached &&
    cached.runId === draft.runId &&
    cached.through === draft.through &&
    cached.id === job.id &&
    cached.source === job.source &&
    cached.nextIndex === index &&
    (cached.before === draft.before ||
      cached.before.revision + 1 === draft.before.revision);
  const plan = continues
    ? cached
    : {
        runId: draft.runId,
        through: draft.through,
        id: job.id,
        source: job.source,
        before: draft.before,
        nextIndex: index,
        value: actionParts(draft, job.id),
      };
  plan.before = draft.before;
  plan.nextIndex = index + 1;
  actionPlans.set(draft.store, plan);
  return plan.value;
}
function saveJob(draft: ProjectionDraft, job: Job): void {
  draft.next.job.objective = job as unknown as Json;
}
function finishJob(draft: ProjectionDraft): void {
  actionPlans.delete(draft.store);
  delete draft.next.job.objective;
}
function cursor(item: ProjectionRow): { order_seq: number; key: string } {
  return { order_seq: item.order_seq, key: item.key };
}
function stepExpansion(draft: ProjectionDraft, job: Job): boolean {
  if (job.type === "all_metrics") {
    const next = draft.page({
      collection: "execution",
      after: job.after,
      limit: 1,
    })[0];
    if (!next) {
      finishJob(draft);
      return true;
    }
    if (!dirty(draft, "metric", next.key)) return false;
    job.after = cursor(next);
    saveJob(draft, job);
    return true;
  }
  const query: ProjectionQuery = {
    collection: "action",
    after: job.after,
    limit: 1,
    ...(job.phase === "direct" ? { owner_id: job.id } : { source_id: job.id }),
  };
  const next = draft.page(query)[0];
  if (next) {
    if (job.phase === "direct") {
      const owner = draft.get("execution", job.id);
      const root = owner ? String(object(owner).root_execution_id) : null;
      if (next.source_id !== root && !draft.put({ ...next, source_id: root }))
        return false;
    }
    if (!dirty(draft, "action", next.key)) return false;
    job.after = cursor(next);
    saveJob(draft, job);
    return true;
  }
  if (job.phase === "direct") {
    job.phase = "root";
    delete job.after;
    saveJob(draft, job);
    return true;
  }
  // An execution may arrive after its traces. Replay only this attribution's indexed suffix.
  const first = draft.page({
    collection: "observation",
    owner_id: job.id,
    limit: 1,
  })[0];
  if (first && !replay(draft, job.id, first.order_seq)) return false;
  finishJob(draft);
  return true;
}
function stepAction(draft: ProjectionDraft, job: Job): boolean {
  if (job.phase === "remove") {
    const collections = [
      "action_item",
      "target",
      "position",
      "metric_event",
    ] as const;
    for (let index = job.collection ?? 0; index < collections.length; index++) {
      const collection = collections[index]!;
      const item = draft.page({
        collection,
        source_id: job.id,
        after: index === job.collection ? job.after : undefined,
        limit: 1,
      })[0];
      if (!item) continue;
      const removed =
        collection === "action_item"
          ? removeContribution(draft, item)
          : collection === "target" || collection === "position"
            ? changeStream(draft, collection, item, false)
            : dirty(draft, "metric", item.owner_id!) &&
              draft.delete(collection, item.key);
      if (!removed) return false;
      // Tombstones remain in MVCC history. Continue after the committed removal
      // rather than rescanning its ever-growing deleted source prefix.
      job.collection = index;
      job.after = cursor(item);
      saveJob(draft, job);
      return true;
    }
    job.phase = "add";
    delete job.collection;
    delete job.after;
    job.index = 0;
    job.source = String(draft.before.revision);
    actionPlans.delete(draft.store);
    saveJob(draft, job);
    return true;
  }
  const { order, parts } = actionPlan(draft, job),
    index = job.index ?? 0,
    part = parts[index];
  if (!part) {
    finishJob(draft);
    return true;
  }
  if (part.contribution) {
    if (
      !putContribution(
        draft,
        "action_item",
        key(job.id, index),
        part.owner,
        job.id,
        order,
        part.contribution,
      )
    )
      return false;
  } else if (part.stream) {
    if (
      !changeStream(
        draft,
        part.stream,
        row(
          part.stream,
          key(part.owner, job.id),
          part.owner,
          job.id,
          order,
          null,
          { token: part.token! },
        ),
        true,
      )
    )
      return false;
  } else if (
    !draft.put(
      row(
        "metric_event",
        key(part.owner, job.id),
        part.owner,
        job.id,
        order,
        null,
        {},
      ),
    ) ||
    !dirty(draft, "metric", part.owner)
  )
    return false;
  job.index = index + 1;
  saveJob(draft, job);
  return true;
}
function stepTrace(draft: ProjectionDraft, job: Job): boolean {
  if (job.phase === "remove") {
    const collections = [
      "trace_applied",
      "trace_tail",
      "trace_reason",
    ] as const;
    for (let index = job.collection ?? 0; index < collections.length; index++) {
      const collection = collections[index]!;
      const item = draft.page({
        collection,
        owner_id: job.id,
        after_order: (job.start ?? 1) - 1,
        after: index === job.collection ? job.after : undefined,
        limit: 1,
      })[0];
      if (!item) continue;
      const removed =
        collection === "trace_applied" && item.tag === "number"
          ? removeContribution(draft, item)
          : dirty(draft, "metric", job.id) &&
            draft.delete(collection, item.key);
      if (!removed) return false;
      job.collection = index;
      job.after = cursor(item);
      saveJob(draft, job);
      return true;
    }
    job.phase = "replay";
    delete job.collection;
    delete job.after;
    saveJob(draft, job);
    return true;
  }
  const pointer = draft.page({
    collection: "observation",
    owner_id: job.id,
    after_order: (job.start ?? 1) - 1,
    after: job.after,
    limit: 1,
  })[0];
  if (!pointer) {
    finishJob(draft);
    return true;
  }
  if (!draft.get("execution", job.id)) {
    job.after = cursor(pointer);
    saveJob(draft, job);
    return true;
  }
  const source = draft.store.historySourceRecord(
    draft.runId,
    "trace",
    pointer.source_id!,
    draft.through,
  );
  if (!source)
    throw new Error(
      "Indexed objective trace missing at pinned source boundary",
    );
  const trace = draft.store.decodeHistorySource("trace", source);
  const parts = traceParts(draft, job.id, trace);
  // A trace has at most three scalar contributions, two reasons and one identity.
  for (let index = 0; index < parts.contributions.length; index++)
    if (
      !putContribution(
        draft,
        "trace_applied",
        key(job.id, trace.trace_seq, index),
        job.id,
        pointer.source_id!,
        trace.trace_seq,
        parts.contributions[index]!,
      )
    )
      return false;
  for (let index = 0; index < parts.reasons.length; index++)
    if (
      !draft.put(
        row(
          "trace_reason",
          key(job.id, trace.trace_seq, index),
          job.id,
          pointer.source_id!,
          trace.trace_seq,
          null,
          { reason: parts.reasons[index]! },
        ),
      )
    )
      return false;
  if (
    parts.sample &&
    !draft.put(
      row(
        "trace_tail",
        sampleIdentity(job.id, parts.sample),
        job.id,
        pointer.source_id!,
        trace.trace_seq,
        null,
        parts.sample as unknown as Json,
      ),
    )
  )
    return false;
  if (!dirty(draft, "metric", job.id)) return false;
  job.after = cursor(pointer);
  saveJob(draft, job);
  return true;
}

/** Each call advances one normalized item; the caller owns batch/deadline scheduling. */
export function stepObjectiveProjection(draft: ProjectionDraft): boolean {
  const active = evidenceObject(
    draft.next.job.objective,
  ) as unknown as Job | null;
  let pending: ProjectionRow | undefined;
  if (!active) {
    for (const tag of [
      "execution",
      "all_metrics",
      "action",
      "trace",
      "metric",
    ]) {
      pending = draft.page({ collection: "dirty_objective", tag, limit: 1 })[0];
      if (pending) break;
    }
  }
  if (!active && !pending) return false;
  let completed: boolean;
  try {
    completed = draft.atomic(() => {
      const job = active;
      if (job) {
        if (job.type === "action") return stepAction(draft, job);
        if (job.type === "trace") return stepTrace(draft, job);
        return stepExpansion(draft, job);
      }
      // Metric updates are emitted only after all contribution work has drained.
      const id = String(object(pending!).id),
        type = pending!.tag!;
      if (type === "metric") {
        const execution = draft.get("execution", id);
        // Indexing can resume against a newer captured frontier before objective
        // work starts. Reconcile with published truth, never an intermediate
        // staged identity carried by the dirty queue (A -> B -> C or A -> B -> A).
        const published = draft.store.historyProjectionRow(
          draft.runId,
          draft.before.published_revision,
          "execution",
          id,
        );
        const removed =
          published &&
          (!execution ||
            published.source_id !== execution.source_id ||
            published.tag !== execution.tag)
            ? object(published)
            : null;
        // A source move removes the old selected scope and replaces the new one
        // in one atomic semantic group, with independently indexed update rows.
        for (const [kind, identity] of [
          ["retract", removed],
          ["replace", execution ? object(execution) : null],
        ] as const) {
          if (!identity) continue;
          if (
            typeof identity.program_name !== "string" ||
            !Number.isSafeInteger(identity.execution_ordinal) ||
            Number(identity.execution_ordinal) < 1 ||
            !Number.isSafeInteger(identity.version) ||
            Number(identity.version) < 1 ||
            typeof identity.skill_id !== "string"
          )
            throw new Error(
              "Metric update lacks its retained named execution identity",
            );
          const sequence = draft.next.metric_change_seq + 1;
          if (
            !draft.put(
              row(
                "metric_update",
                String(sequence),
                id,
                String(identity.skill_id),
                sequence,
                key(String(identity.skill_id), Number(identity.version)),
                {
                  execution_id: id,
                  revision: draft.before.revision + 1,
                  generation: draft.before.generation + 1,
                  kind,
                  program: {
                    name: identity.program_name,
                    version: Number(identity.version),
                  },
                  execution_ordinal: Number(identity.execution_ordinal),
                  ...(kind === "retract"
                    ? { reason: "execution_removed" }
                    : {}),
                },
              ),
            )
          )
            return false;
          draft.next.metric_change_seq = sequence;
        }
      } else
        saveJob(draft, {
          type,
          id,
          phase:
            type === "execution"
              ? "direct"
              : type === "all_metrics"
                ? "page"
                : "remove",
          ...(type === "trace" ? { start: pending!.order_seq } : {}),
        });
      return draft.delete("dirty_objective", pending!.key);
    });
  } catch (error) {
    actionPlans.delete(draft.store);
    throw error;
  }
  // A full batch rolls back the speculative continuation, not its immutable
  // source plan. Evicting that plan here would normalize N items once per batch.
  if (!completed) {
    const restored = evidenceObject(
      draft.next.job.objective,
    ) as unknown as Job | null;
    const plan = actionPlans.get(draft.store);
    if (
      plan &&
      restored?.type === "action" &&
      restored.phase === "add" &&
      restored.id === plan.id &&
      restored.source === plan.source
    )
      plan.nextIndex = restored.index ?? 0;
    else actionPlans.delete(draft.store);
  }
  return completed;
}

const cap = (value: number | undefined): number =>
  Math.max(1, Math.min(128, Math.trunc(value ?? 128)));
function revisionAt(
  store: StoreReadQueries,
  runId: string,
  generation?: number,
): number | null {
  return store.historyProjectionGeneration(runId, generation)?.revision ?? null;
}
function* requestedRows(
  store: StoreReadQueries,
  runId: string,
  revision: number,
  query: ProjectionQuery,
): Generator<ProjectionRow> {
  let after = query.after;
  while (true) {
    const values = store.historyProjectionRows(runId, revision, {
      ...query,
      after,
    });
    yield* values;
    if (values.length < (query.limit ?? 128)) return;
    after = cursor(values[values.length - 1]!);
  }
}
/** Complete requested-execution accounting, assembled through bounded indexed pages. */
export function readProjectedObjectiveMetric(
  store: StoreReadQueries,
  runId: string,
  executionId: string,
  generation?: number,
): ObjectiveMetrics | null {
  const revision = revisionAt(store, runId, generation);
  if (revision === null) return null;
  const execution = store.historyProjectionRow(
    runId,
    revision,
    "execution",
    executionId,
  );
  if (!execution) return null;
  const metadata = object(execution),
    numbers: Record<string, number> = Object.create(null);
  for (const value of store.historyProjectionRows(runId, revision, {
    collection: "metric_number",
    owner_id: executionId,
    limit: 128,
  }))
    numbers[value.tag!] = historySumValue(String(object(value).coefficient));
  const metric: ObjectiveMetrics = {
    execution_id: executionId,
    root_execution_id: String(metadata.root_execution_id),
    outcome: String(metadata.status),
    confirmed_block_removals: numbers.confirmed_block_removals ?? 0,
    removed_blocks: {},
    inventory_delta: {},
    inventory_receipts: numbers.inventory_receipts ?? 0,
    target_switches: numbers.target_switches ?? 0,
    target_position_switches: numbers.target_position_switches ?? 0,
    sampled_travel_distance: numbers.sampled_travel_distance ?? 0,
    sampled_rotation_degrees: numbers.sampled_rotation_degrees ?? 0,
    observation_samples: numbers.observation_samples ?? 0,
    receipted_travel_distance: numbers.receipted_travel_distance ?? 0,
    receipted_rotation_degrees: numbers.receipted_rotation_degrees ?? 0,
    motion_receipts: numbers.motion_receipts ?? 0,
    spans_ms: {},
    span_samples: {},
    evidence_event_seqs: [],
    trace_complete: true,
    limitations: [...BASE_LIMITATIONS],
  };
  for (const field of [
    "removed_blocks",
    "inventory_delta",
    "spans_ms",
    "span_samples",
  ] as const) {
    const query = {
      collection: "metric_item" as const,
      owner_id: executionId,
      tag: field,
    };
    for (const value of requestedRows(store, runId, revision, {
      ...query,
      limit: 128,
    })) {
      (metric[field] as Record<string, number>)[value.source_id!] =
        historySumValue(String(object(value).coefficient));
    }
  }
  const refs = { collection: "metric_event" as const, owner_id: executionId };
  for (const value of requestedRows(store, runId, revision, {
    ...refs,
    limit: 128,
  }))
    metric.evidence_event_seqs.push(value.order_seq);
  const budget = object(
    store.historyProjectionRow(
      runId,
      revision,
      "run_state",
      "objective_budget",
    ),
  );
  const reasonCount = store.historyProjectionCount(runId, revision, {
    collection: "trace_reason",
    owner_id: executionId,
  });
  if (Number(budget.omitted ?? 0) > 0 || reasonCount > 0)
    metric.trace_complete = false;
  for (const value of requestedRows(store, runId, revision, {
    collection: "trace_reason",
    owner_id: executionId,
    limit: 128,
  })) {
    const reason = String(object(value).reason);
    if (reason !== "record omission" && !metric.limitations.includes(reason))
      metric.limitations.push(reason);
  }
  if (!metric.observation_samples) metric.limitations.push(NO_SAMPLES);
  if (!metric.trace_complete) metric.limitations.push(INCOMPLETE);
  return metric;
}
export type ObjectiveMetricsPageOptions = {
  generation?: number;
  after?: { order_seq: number; key: string };
  offset?: number;
  limit?: number;
  skill_id?: string;
  version?: number;
  eligible_only?: boolean;
};
export function readProjectedObjectiveMetricsPage(
  store: StoreReadQueries,
  runId: string,
  options: ObjectiveMetricsPageOptions = {},
): {
  metrics: ObjectiveMetrics[];
  next_after: { order_seq: number; key: string } | null;
  next_offset: number;
  has_more: boolean;
  total: number;
} {
  const published = store.historyProjectionGeneration(
      runId,
      options.generation,
    ),
    offset = options.offset ?? 0;
  if (!published)
    return {
      metrics: [],
      next_after: null,
      next_offset: offset,
      has_more: false,
      total: 0,
    };
  const revision = published.revision;
  const selector: ProjectionQuery = {
    collection: options.eligible_only ? "metric_population" : "execution",
    ...(options.skill_id !== undefined ? { source_id: options.skill_id } : {}),
    ...(options.skill_id !== undefined && options.version !== undefined
      ? { tag: key(options.skill_id, options.version) }
      : {}),
  };
  const total = store.historyProjectionCount(runId, revision, selector);
  const values = store.historyProjectionRows(runId, revision, {
    ...selector,
    after: options.after,
    offset,
    limit: cap(options.limit),
  });
  const metrics = values
    .map((value) =>
      readProjectedObjectiveMetric(
        store,
        runId,
        value.key,
        published.generation,
      ),
    )
    .filter((value): value is ObjectiveMetrics => value !== null);
  const next = values.at(-1),
    nextOffset = offset + values.length;
  const hasMore =
    options.after && next
      ? store.historyProjectionRows(runId, revision, {
          ...selector,
          after: cursor(next),
          limit: 1,
        }).length > 0
      : nextOffset < total;
  return {
    metrics,
    next_after: next ? cursor(next) : null,
    next_offset: nextOffset,
    has_more: hasMore,
    total,
  };
}
