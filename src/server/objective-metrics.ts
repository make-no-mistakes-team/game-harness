import type { Json } from "../shared/contracts.ts";
import { confirmedMinecraftCraftStages, confirmedMinecraftGuiTransactions, historicalObservationV2Schema, minecraftObservationV3Schema, type MinecraftPlayer } from "../shared/minecraft.ts";
import type { ObjectiveMetrics, PauseCategory, TraceRecord } from "../shared/execution-evidence.ts";
import type { StoredAction } from "./store.ts";
import type { StoreReadQueries } from "./store-read.ts";
export type ObjectiveMetricsReadStore = Pick<StoreReadQueries, "allSkillExecutions" | "eventsAfter" | "getAction" | "tracePage">;
export const evidenceObject = (value: unknown): Record<string, Json> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : null;
export function confirmedRemoval(action: StoredAction): boolean {
  const receipt = evidenceObject(action.view.result?.evidence);
  return action.request.kind === "dig" && action.view.status === "succeeded" && receipt?.effect_confirmed === true && (receipt.block_removed === true || receipt.source === "server_block_update");
}
export const eligibleLog = (name: string): boolean => /^(?:stripped_)?[a-z0-9_]+_(?:log|wood|stem|hyphae)$/.test(name);
export function receiptedInventoryDelta(action: StoredAction): Record<string, number> | null {
  const receipt = evidenceObject(action.view.result?.evidence);
  const stages = action.request.kind === "craft" && ("sequence" in action.request || receipt?.craft_stages !== undefined);
  if (action.request.kind === "screen_input" || stages) {
    const facts = stages
      ? confirmedMinecraftCraftStages(action.request, receipt)
      : confirmedMinecraftGuiTransactions(action.request, receipt);
    if (!facts.length) return null;
    const delta: Record<string, number> = Object.create(null);
    // Stage receipts supersede the aggregate, including when a later stage is unknown.
    for (const fact of facts) for (const item of new Set([...Object.keys(fact.inventory_before), ...Object.keys(fact.inventory_after)])) {
      const count = (delta[item] ?? 0) + (fact.inventory_after[item] ?? 0) - (fact.inventory_before[item] ?? 0);
      if (!Number.isSafeInteger(count)) return null;
      delta[item] = count;
    }
    return delta;
  }
  if (receipt?.inventory_receipt_confirmed !== true) return null;
  const before = evidenceObject(receipt.inventory_before), after = evidenceObject(receipt.inventory_after);
  const delta = evidenceObject(receipt.inventory_delta);
  const result: Record<string, number> = {};
  if (before && after) {
    for (const item of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const old = before[item] ?? 0, next = after[item] ?? 0;
      if (typeof old === "number" && typeof next === "number" && Number.isFinite(old) && Number.isFinite(next)) result[item] = next - old;
    }
  } else if (delta) {
    for (const [item, count] of Object.entries(delta)) if (typeof count === "number" && Number.isFinite(count)) result[item] = count;
  } else return null;
  return result;
}
/** Descriptive observed samples, never a gameplay-quality or causal score. */
export function objectiveMetrics(store: ObjectiveMetricsReadStore, runId: string): ObjectiveMetrics[] {
  const executions = store.allSkillExecutions(runId);
  const metrics = new Map<string, ObjectiveMetrics>();
  for (const execution of executions) metrics.set(execution.execution_id, {
    execution_id: execution.execution_id, root_execution_id: execution.root_execution_id, outcome: execution.status,
    confirmed_block_removals: 0, removed_blocks: {}, inventory_delta: {}, inventory_receipts: 0,
    target_switches: 0, target_position_switches: 0, sampled_travel_distance: 0, sampled_rotation_degrees: 0, observation_samples: 0,
    receipted_travel_distance: 0, receipted_rotation_degrees: 0, motion_receipts: 0,
    spans_ms: {}, span_samples: {}, evidence_event_seqs: [], trace_complete: true,
    limitations: ["Travel and rotation are sampled authorized observations, not a complete trajectory.", "Block removals are not classified as necessary or wrong; item origin and tree identity are unknown.", "Span categories can overlap and must not be summed as exclusive wall time."],
  });
  const previousTarget = new Map<string, string>(), previousPosition = new Map<string, string>();
  const seen = new Set<string>();
  let cursor = 0;
  while (true) {
    const events = store.eventsAfter(runId, cursor, 500);
    for (const event of events) {
      const details = evidenceObject(event.details);
      if (!["action.succeeded", "action.failed", "action.cancelled", "action.unknown"].includes(event.type) || typeof details?.action_id !== "string" || seen.has(details.action_id)) continue;
      const action = store.getAction(runId, details.action_id);
      if (!action?.view.execution_id) continue;
      seen.add(details.action_id);
      const owner = executions.find((execution) => execution.execution_id === action.view.execution_id);
      if (!owner) continue;
      const receipt = evidenceObject(action.view.result?.evidence);
      for (const id of new Set([owner.execution_id, owner.root_execution_id])) {
        const metric = metrics.get(id);
        if (!metric) continue;
        if (confirmedRemoval(action)) {
          metric.confirmed_block_removals++;
          const name = typeof receipt?.target_name === "string" ? receipt.target_name : "unknown";
          metric.removed_blocks[name] = (metric.removed_blocks[name] ?? 0) + 1;
        }
        const delta = receiptedInventoryDelta(action);
        if (delta) {
          metric.inventory_receipts++;
          for (const [name, count] of Object.entries(delta)) metric.inventory_delta[name] = (metric.inventory_delta[name] ?? 0) + count;
        }
        if (typeof receipt?.travel_distance === "number" && Number.isFinite(receipt.travel_distance) && receipt.travel_distance >= 0) {
          metric.receipted_travel_distance += receipt.travel_distance;
          metric.motion_receipts++;
        }
        if (typeof receipt?.rotation_yaw_radians === "number" && typeof receipt.rotation_pitch_radians === "number" && Number.isFinite(receipt.rotation_yaw_radians) && Number.isFinite(receipt.rotation_pitch_radians))
          metric.receipted_rotation_degrees += (Math.abs(receipt.rotation_yaw_radians) + Math.abs(receipt.rotation_pitch_radians)) * 180 / Math.PI;
        for (const [field, category] of [
          ["native_action_ms", "native_action"],
          ["native_dispatch_queue_ms", "dispatch"],
          ["native_baseline_receipt_wait_ms", "readiness"],
          ["native_dispatch_receipt_ms", "receipt"],
          ["native_respawn_readiness_wait_ms", "readiness"],
          ["native_life_recovery_ms", "life_recovery"],
        ] as const) {
          const duration = receipt?.[field];
          if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
            metric.spans_ms[category] = (metric.spans_ms[category] ?? 0) + duration;
            metric.span_samples[category] = (metric.span_samples[category] ?? 0) + 1;
          }
        }
        const targetRef = evidenceObject(action.request.target);
        const target = targetRef ? JSON.stringify(targetRef) : typeof action.request.target_id === "string" ? `historical:${action.request.target_id}` : null;
        if (target !== null) {
          if (previousTarget.has(id) && previousTarget.get(id) !== target) metric.target_switches++;
          previousTarget.set(id, target);
        }
        if (receipt?.target_position) {
          const position = JSON.stringify({ scope: action.view.scope ? { world_id: action.view.scope.world_id, session_id: action.view.scope.session_id,
            native_boot_id: action.view.scope.native_boot_id, space_epoch: action.view.scope.space_epoch } : { historical_session: action.view.session_id },
            position: receipt.target_position });
          if (previousPosition.has(id) && previousPosition.get(id) !== position) metric.target_position_switches++;
          previousPosition.set(id, position);
        }
        metric.evidence_event_seqs.push(event.event_seq);
      }
    }
    if (events.length < 500) break;
    cursor = events[events.length - 1]!.event_seq;
  }
  const observations = new Map<string, { scope: string; sequence: number; player: MinecraftPlayer }>();
  const sampleIds = new Map<string, Set<string>>();
  const apply = (trace: TraceRecord): void => {
    const payload = evidenceObject(trace.payload);
    // Minecraft owns this descriptive motion interpretation. Explicit history
    // decoding never relabels schema2, and no travel is measured across spaces.
    let sample: { scope: string; sequence: number; player: MinecraftPlayer } | null = null;
    if (trace.kind === "observation" && payload?.schema_version === 3) {
      const parsed = minecraftObservationV3Schema.safeParse(trace.payload);
      if (parsed.success) {
        const observation = parsed.data;
        sample = { scope: JSON.stringify([3, observation.world_id, observation.session_id, observation.epoch,
          observation.native_boot_id, observation.life.life_id, observation.space]), sequence: observation.observation_seq, player: observation.data.player };
      }
    } else if (trace.kind === "observation" && payload?.schema_version === 2) {
      const parsed = historicalObservationV2Schema.safeParse(trace.payload);
      if (parsed.success) sample = { scope: JSON.stringify([2, parsed.data.world_id, parsed.data.session_id, parsed.data.epoch, parsed.data.life.life_id]),
        sequence: parsed.data.observation_seq, player: parsed.data.player };
    }
    for (const id of new Set([trace.execution_id, trace.root_execution_id])) {
      const metric = id ? metrics.get(id) : null;
      if (!metric) continue;
      if (trace.omission) metric.trace_complete = false;
      if (trace.kind === "branch" && typeof payload?.omitted === "number" && payload.omitted > 0) {
        metric.trace_complete = false;
        const limitation = "Source-branch diagnostic decisions were omitted by the worker budget; gameplay receipt validity is unchanged.";
        if (!metric.limitations.includes(limitation)) metric.limitations.push(limitation);
      }
      if (trace.kind === "branch" && payload?.tail_incomplete === true) {
        metric.trace_complete = false;
        const limitation = `Source-branch diagnostic tail is incomplete (${typeof payload.loss_reason === "string" ? payload.loss_reason : "unknown"}); missing decision count is unknown and gameplay receipt validity is unchanged.`;
        if (!metric.limitations.includes(limitation)) metric.limitations.push(limitation);
      }
      if (sample) {
        const key = `${sample.scope}:${sample.sequence}`;
        const samples = sampleIds.get(id!) ?? new Set<string>();
        if (samples.has(key)) continue;
        samples.add(key); sampleIds.set(id!, samples);
        const previous = observations.get(id!);
        metric.observation_samples++;
        if (previous && previous.scope === sample.scope) {
          const a = previous.player, b = sample.player;
          metric.sampled_travel_distance += Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y, b.position.z - a.position.z);
          const yawDelta = b.yaw - a.yaw;
          metric.sampled_rotation_degrees += (Math.abs(Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta))) + Math.abs(b.pitch - a.pitch)) * 180 / Math.PI;
        }
        observations.set(id!, sample);
      } else if (trace.kind === "span" && payload?.clock === "same_process_monotonic" && typeof payload.category === "string" && typeof payload.duration_ms === "number" && payload.duration_ms >= 0) {
        const category = payload.category as PauseCategory;
        metric.spans_ms[category] = (metric.spans_ms[category] ?? 0) + payload.duration_ms;
        metric.span_samples[category] = (metric.span_samples[category] ?? 0) + 1;
      }
    }
  };
  cursor = 0;
  while (true) {
    const page = store.tracePage(runId, cursor, 500);
    for (const record of page.records) apply(record);
    if (page.budget.omitted_records) for (const metric of metrics.values()) metric.trace_complete = false;
    if (!page.has_more) break;
    cursor = page.next_after;
  }
  for (const metric of metrics.values()) {
    if (!metric.observation_samples) metric.limitations.push("No persisted authorized observation samples.");
    if (!metric.trace_complete) metric.limitations.push("Trace omissions or incomplete diagnostic tails prevent complete execution reconstruction; retained gameplay receipts remain independently assessable.");
  }
  return [...metrics.values()];
}
